import * as v from "valibot";
import { afterAll, beforeAll, expect, test } from "vitest";
import worker, { fetchPublicApplication } from "../src/application.ts";
import { APP_ORIGIN, accountRequest, anonymousCreationKey, createIdentityFixture } from "./support/identity-fixture.ts";

let fixture: Awaited<ReturnType<typeof createIdentityFixture>>;

beforeAll(async () => {
    fixture = await createIdentityFixture();
});

afterAll(async () => {
    await fixture.close();
});

/** Declares its length as HTTP clients do, so the request keeps Cloudflare's location metadata. */
function creationRequest(headers: Readonly<Record<string, string>> = {}): Request {
    const body = JSON.stringify({ creationKey: anonymousCreationKey() });
    return new Request(`${APP_ORIGIN}/morty/api/identity/anonymous-users`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", "content-length": String(body.length) },
        body,
    });
}

test("Given an identity creation whose reply was lost, When the client retries it with the same creation key, Then it receives the same identity, Project and Machine", async () => {
    const environment = fixture.environment();
    const creationKey = anonymousCreationKey();
    const create = async () => {
        const response = await worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/identity/anonymous-users`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ creationKey }),
            }),
            environment,
        );
        expect(response.status).toBe(201);
        return v.parse(
            v.object({
                token: v.string(),
                userId: v.string(),
                projectId: v.string(),
                bot: v.object({ botId: v.string() }),
            }),
            await response.json(),
        );
    };

    const lost = await create();
    const retried = await create();

    expect(retried).toEqual(lost);
    const session = await worker.fetch(accountRequest(retried.token, retried.projectId), environment);
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ userId: lost.userId });
});

test("Given visitors across Cloudflare regions, When Chat provisions and reopens Morty data, Then Platform preserves every placement", {
    timeout: 30_000,
}, async () => {
    // Cloudflare supplies cf metadata on incoming Requests; Node does not.
    class GeolocatedRequest extends Request {
        override readonly cf: { readonly continent: string; readonly country: string };
        constructor(request: Request, continent: string, country: string) {
            super(request);
            this.cf = { continent, country };
        }
    }
    const environment = fixture.environment();
    for (const [continent, country, region] of [
        ["AS", "CN", "apac-ne"],
        ["AS", "SG", "apac-se"],
        ["AS", "IN", "apac"],
        ["OC", "AU", "apac"],
        ["NA", "US", "wnam"],
        ["SA", "BR", "wnam"],
        ["EU", "DE", "wnam"],
        ["AF", "ZA", "wnam"],
        ["AN", "AQ", "wnam"],
        ["unknown", "US", "apac"],
    ] as const) {
        const created = await worker.fetch(
            new GeolocatedRequest(creationRequest({ "cf-ipcountry": "US" }), continent, country),
            environment,
        );
        expect(created.status).toBe(201);
        const identity = v.parse(v.object({ token: v.string(), projectId: v.string() }), await created.json());
        const projectRequest = () =>
            new Request(`${APP_ORIGIN}/morty/api/projects/${identity.projectId}/management/project`, {
                headers: { authorization: `Bearer ${identity.token}` },
            });
        const response = await worker.fetch(projectRequest(), environment);
        expect(response.status).toBe(200);
        const initial = v.parse(v.object({ project: v.object({ projectId: v.string() }) }), await response.json());
        const projectCode = { apac: "ap", "apac-ne": "an", "apac-se": "as", wnam: "wn" }[region];
        expect(initial.project.projectId).toMatch(new RegExp(`^prj_${projectCode}_01_`));
        const revisited = await worker.fetch(
            new GeolocatedRequest(projectRequest(), region === "wnam" ? "AS" : "NA", region === "wnam" ? "CN" : "US"),
            environment,
        );
        expect(revisited.status).toBe(200);
        expect(await revisited.json()).toMatchObject(initial);
    }
});

test("Given explicit location choices, When users create Morty identities, Then every supported Project code is honored", async () => {
    for (const [locationHint, projectCode] of [
        ["wnam", "wn"],
        ["enam", "en"],
        ["sam", "sa"],
        ["weur", "we"],
        ["eeur", "ee"],
        ["apac", "ap"],
        ["apac-ne", "an"],
        ["apac-se", "as"],
        ["oc", "oc"],
        ["afr", "af"],
        ["me", "me"],
    ] as const) {
        const response = await worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/identity/anonymous-users`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ creationKey: anonymousCreationKey(), locationHint }),
            }),
            fixture.environment(),
        );

        expect(response.status).toBe(201);
        const identity = v.parse(v.object({ projectId: v.string() }), await response.json());
        expect(identity.projectId).toMatch(new RegExp(`^prj_${projectCode}_01_`, "u"));
    }
});

test("Given Projects in separate regions, When users reopen and transfer Morty access, Then Project objects retain their identities and reject another Project", async () => {
    const environment = fixture.environment();
    class RegionalRequest extends Request {
        override readonly cf: { readonly continent: string };
        constructor(continent: string) {
            super(creationRequest());
            this.cf = { continent };
        }
    }
    const identitySchema = v.object({ userId: v.string(), projectId: v.string(), token: v.string() });
    const asian = await worker.fetch(new RegionalRequest("AS"), environment);
    const american = await worker.fetch(new RegionalRequest("NA"), environment);
    expect(asian.status).toBe(201);
    expect(american.status).toBe(201);
    const apac = v.parse(identitySchema, await asian.json());
    const wnam = v.parse(identitySchema, await american.json());
    const sameRegionResponse = await worker.fetch(new RegionalRequest("AS"), environment);
    expect(sameRegionResponse.status).toBe(201);
    const sameRegion = v.parse(identitySchema, await sameRegionResponse.json());
    expect((await worker.fetch(accountRequest(apac.token, sameRegion.projectId), environment)).status).toBe(401);
    expect((await worker.fetch(accountRequest(apac.token), environment)).status).toBe(401);
    for (const [identity, other] of [
        [apac, wnam],
        [wnam, apac],
    ]) {
        if (identity === undefined || other === undefined) {
            throw new Error("Missing identity fixture");
        }
        const session = await worker.fetch(accountRequest(identity.token, identity.projectId), environment);
        expect(session.status).toBe(200);
        expect(await session.json()).toMatchObject({ userId: identity.userId });
        expect((await worker.fetch(accountRequest(identity.token, other.projectId), environment)).status).toBe(401);
        const transfer = await worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/projects/${identity.projectId}/identity/transfers`, {
                method: "POST",
                headers: { authorization: `Bearer ${identity.token}` },
            }),
            environment,
        );
        expect(transfer.status).toBe(201);
        const { url } = v.parse(v.object({ url: v.string() }), await transfer.json());
        const code = new URLSearchParams(new URL(url).hash.slice(1)).get("code");
        const redeem = () =>
            worker.fetch(
                new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ code }),
                }),
                environment,
            );
        const redeemed = await redeem();
        expect(redeemed.status).toBe(200);
        expect(await redeemed.json()).toMatchObject({ userId: identity.userId, projectId: identity.projectId });
        const reopened = await redeem();
        expect(reopened.status).toBe(200);
        expect(await reopened.json()).toMatchObject({ userId: identity.userId, projectId: identity.projectId });
    }
});

test("Given a first-time visitor, When their identity and Bot are managed, Then both persist behind the Project boundary", async () => {
    const identity = await fixture.createAnonymousUser();
    const response = await worker.fetch(accountRequest(identity.token, identity.projectId), fixture.environment());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
        authentication: { kind: "anonymous" },
        userId: identity.userId,
    });
    const served = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/projects/${identity.projectId}/management/bot`, {
            headers: { authorization: `Bearer ${identity.token}` },
        }),
        fixture.environment(),
    );
    expect(served.status).toBe(200);
    const bot = v.parse(v.object({ botId: v.string(), runtimeId: v.null() }), await served.json());
    const persisted = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/projects/${identity.projectId}/management/bots/${bot.botId}`, {
            headers: { authorization: `Bearer ${identity.token}` },
        }),
        fixture.environment(),
    );
    expect(await persisted.json()).toEqual({
        botId: bot.botId,
        configured: false,
        displayName: "My Machine",
        instructions: "",
    });
    const projectResponse = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/projects/${identity.projectId}/management/project`, {
            headers: { authorization: `Bearer ${identity.token}` },
        }),
        fixture.environment(),
    );
    const { project } = v.parse(
        v.object({ project: v.object({ projectId: v.string() }) }),
        await projectResponse.json(),
    );
    expect(identity.projectId).toBe(project.projectId);
    expect(identity.token).toMatch(/^mobius_anon_v2_[A-Za-z0-9_-]{43}$/u);
    expect(
        (await worker.fetch(accountRequest(identity.token, `prj_wn_01_${"z".repeat(24)}`), fixture.environment()))
            .status,
    ).toBe(401);
});

test("Given a user with a draft Bot on a Project-scoped Platform, When setup lists Runtimes, Then the available Runtime options are returned", async () => {
    const environment = fixture.environment();
    const identity = await fixture.createAnonymousUser();
    const served = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/projects/${identity.projectId}/management/bot`, {
            headers: { authorization: `Bearer ${identity.token}` },
        }),
        environment,
    );
    const { botId } = v.parse(v.object({ botId: v.string() }), await served.json());
    const response = await fetchPublicApplication(
        new Request(`${APP_ORIGIN}/morty/api/chat/projects/${identity.projectId}/bots/${botId}/setup/runtimes`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${identity.token}`,
                "content-type": "application/json",
            },
            body: "{}",
        }),
        environment,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ runtimes: [] });
});

test("Given an anonymous user, When machine access is shared, Then its expiring continue URL remains reusable beyond five uses and issued access remains available until revoked", async () => {
    const environment = fixture.environment();
    const owner = await fixture.createAnonymousUser();
    const createTransfer = async () => {
        const response = await worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/projects/${owner.projectId}/identity/transfers`, {
                method: "POST",
                headers: { authorization: `Bearer ${owner.token}` },
            }),
            environment,
        );
        expect(response.status).toBe(201);
        const transfer = v.parse(
            v.object({ url: v.string(), expiresAt: v.pipe(v.string(), v.isoTimestamp()) }),
            await response.json(),
        );
        return { ...transfer, code: new URL(transfer.url).hash.slice("#code=".length) };
    };
    const redeem = (code: string) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code }),
            }),
            environment,
        );

    const remoteTransfer = await createTransfer();
    const remoteTokens = [];
    for (let redemption = 0; redemption < 2; redemption++) {
        const response = await redeem(remoteTransfer.code);
        expect(response.status).toBe(200);
        remoteTokens.push(v.parse(v.object({ token: v.string() }), await response.json()).token);
    }
    const recoveryResponse = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/projects/${owner.projectId}/identity/recovery-token`, {
            method: "POST",
            headers: { authorization: `Bearer ${owner.token}` },
        }),
        environment,
    );
    expect(recoveryResponse.status).toBe(201);
    const recoveryToken = v.parse(
        v.object({ token: v.pipe(v.string(), v.startsWith("mobius_recovery_v1.")) }),
        await recoveryResponse.json(),
    ).token;
    const ended = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/projects/${owner.projectId}/identity/v1/browser-access`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${remoteTokens[0]}` },
        }),
        environment,
    );
    expect(ended.status).toBe(204);
    for (const token of remoteTokens) {
        expect((await worker.fetch(accountRequest(token, owner.projectId), environment)).status).toBe(401);
    }
    expect((await redeem(remoteTransfer.code)).status).toBe(410);
    expect((await worker.fetch(accountRequest(recoveryToken, owner.projectId), environment)).status).toBe(200);
    expect((await worker.fetch(accountRequest(owner.token, owner.projectId), environment)).status).toBe(200);

    const reusableTransfer = await createTransfer();
    const issuedTokens = [];
    for (let redemption = 0; redemption < 6; redemption++) {
        const response = await redeem(reusableTransfer.code);
        expect(response.status).toBe(200);
        const received = v.parse(
            v.object({ userId: v.string(), token: v.pipe(v.string(), v.startsWith("mobius_anon_v2_")) }),
            await response.json(),
        );
        expect(received.userId).toBe(owner.userId);
        issuedTokens.push(received.token);
    }
    expect(new Set(issuedTokens).size).toBe(6);
    expect((await worker.fetch(accountRequest(issuedTokens[0] ?? "", owner.projectId), environment)).status).toBe(200);
});

test("Given an anonymous user with a Machine, When a transfer link is redeemed, Then the redemption returns the user's Bot", async () => {
    const environment = fixture.environment();
    const identity = await fixture.createAnonymousUser();
    const servedResponse = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/projects/${identity.projectId}/management/bot`, {
            headers: { authorization: `Bearer ${identity.token}` },
        }),
        environment,
    );
    expect(servedResponse.status).toBe(200);
    const served = v.parse(v.object({ botId: v.string() }), await servedResponse.json());
    const transfer = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/projects/${identity.projectId}/identity/transfers`, {
            method: "POST",
            headers: { authorization: `Bearer ${identity.token}` },
        }),
        environment,
    );
    expect(transfer.status).toBe(201);
    const { url } = v.parse(v.object({ url: v.string() }), await transfer.json());
    const code = new URL(url).hash.slice("#code=".length);
    const redeemed = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code }),
        }),
        environment,
    );
    expect(redeemed.status).toBe(200);
    expect(await redeemed.json()).toMatchObject({
        userId: identity.userId,
        projectId: identity.projectId,
        botId: served.botId,
    });
});

test("Given the first browser for Morty, When it retires its local credential after a recovery token is created, Then that credential is revoked and recovery remains available", async () => {
    const environment = fixture.environment();
    const identity = await fixture.createAnonymousUser();
    const recoveryResponse = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/projects/${identity.projectId}/identity/recovery-token`, {
            method: "POST",
            headers: { authorization: `Bearer ${identity.token}` },
        }),
        environment,
    );
    expect(recoveryResponse.status).toBe(201);
    const recoveryToken = v.parse(v.object({ token: v.string() }), await recoveryResponse.json()).token;

    const ended = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/projects/${identity.projectId}/identity/v1/local-credential`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${identity.token}` },
        }),
        environment,
    );

    expect(ended.status).toBe(204);
    expect((await worker.fetch(accountRequest(identity.token, identity.projectId), environment)).status).toBe(401);
    expect((await worker.fetch(accountRequest(recoveryToken, identity.projectId), environment)).status).toBe(200);
});

test("Given anonymous Morty sessions, When the account endpoint authenticates them, Then only valid active identities are disclosed", async () => {
    const unauthenticated = await worker.fetch(accountRequest(), {});
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    for (const token of ["mobius_anon_v2_invalid", "user_alice"]) {
        expect((await worker.fetch(accountRequest(token), fixture.baseConfiguration)).status).toBe(401);
    }
    const environment = fixture.environment();
    const local = await fixture.createAnonymousUser();
    const response = await worker.fetch(accountRequest(local.token, local.projectId), environment);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
        authentication: { kind: "anonymous" },
        userId: local.userId,
    });
});

test("Given browser access the owner revoked, When the browser presents its credential, Then the Worker reports that its access ended instead of an unknown credential", async () => {
    const environment = fixture.environment();
    const owner = await fixture.createAnonymousUser();
    const transfer = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/projects/${owner.projectId}/identity/transfers`, {
            method: "POST",
            headers: { authorization: `Bearer ${owner.token}` },
        }),
        environment,
    );
    const code = new URL(v.parse(v.object({ url: v.string() }), await transfer.json()).url).hash.slice("#code=".length);
    const redeemed = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code }),
        }),
        environment,
    );
    const browser = v.parse(v.object({ token: v.string() }), await redeemed.json()).token;
    const revoked = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/projects/${owner.projectId}/identity/revoke-all-access`, {
            method: "POST",
            headers: { authorization: `Bearer ${owner.token}` },
        }),
        environment,
    );
    expect(revoked.status).toBe(200);
    const management = (token: string) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/projects/${owner.projectId}/management/bot`, {
                headers: { authorization: `Bearer ${token}` },
            }),
            environment,
        );
    const unknownToken = `mobius_anon_v2_${"A".repeat(43)}`;

    // Released pages read the status and code, which stay as they were.
    for (const response of [
        await worker.fetch(accountRequest(browser, owner.projectId), environment),
        await management(browser),
    ]) {
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({
            error: { code: "UNAUTHENTICATED", message: "Access to this computer has ended.", reason: "ACCESS_REVOKED" },
        });
    }
    for (const response of [
        await worker.fetch(accountRequest(unknownToken, owner.projectId), environment),
        await management(unknownToken),
    ]) {
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } });
    }
    expect((await worker.fetch(accountRequest(owner.token, owner.projectId), environment)).status).toBe(200);
});

test("Given a browser that opened one link, When it opens another link for the same user and later ends its access, Then its earlier credential stops at once and both links stop opening Morty", async () => {
    const environment = fixture.environment();
    const owner = await fixture.createAnonymousUser();
    const request = (path: string, token: string, init: RequestInit = {}) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/projects/${owner.projectId}${path}`, {
                ...init,
                headers: { authorization: `Bearer ${token}`, ...init.headers },
            }),
            environment,
        );
    const share = async () => {
        const response = await request("/identity/transfers", owner.token, { method: "POST" });
        expect(response.status).toBe(201);
        return new URL(v.parse(v.object({ url: v.string() }), await response.json()).url).hash.slice("#code=".length);
    };
    const redeem = (code: string, replaces?: string) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code, ...(replaces === undefined ? {} : { replaces }) }),
            }),
            environment,
        );
    const opened = async (code: string, replaces?: string) => {
        const response = await redeem(code, replaces);
        expect(response.status).toBe(200);
        return v.parse(v.object({ token: v.string() }), await response.json()).token;
    };
    const firstLink = await share();
    const secondLink = await share();
    const phone = await opened(firstLink);
    const earlier = await opened(firstLink);

    const later = await opened(secondLink, earlier);

    // The browser keeps one credential: the one it opened the later link with replaces the earlier one.
    expect((await request("/session", earlier)).status).toBe(401);
    expect((await request("/session", later)).status).toBe(200);
    expect((await request("/session", phone)).status).toBe(200);

    expect((await request("/identity/v1/browser-access", later, { method: "DELETE" })).status).toBe(204);

    // Ending this browser's access ends every link it joined through, and what they granted.
    for (const code of [firstLink, secondLink]) {
        expect((await redeem(code)).status).toBe(410);
    }
    for (const token of [later, phone]) {
        expect((await request("/session", token)).status).toBe(401);
    }
    expect((await request("/session", owner.token)).status).toBe(200);
});

test("Given two tabs of one browser open new links at once, When the browser later ends its access from either tab, Then every link it joined through stops opening Morty", async () => {
    const environment = fixture.environment();
    const owner = await fixture.createAnonymousUser();
    const request = (path: string, token: string, init: RequestInit = {}) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/projects/${owner.projectId}${path}`, {
                ...init,
                headers: { authorization: `Bearer ${token}`, ...init.headers },
            }),
            environment,
        );
    const share = async () => {
        const response = await request("/identity/transfers", owner.token, { method: "POST" });
        expect(response.status).toBe(201);
        return new URL(v.parse(v.object({ url: v.string() }), await response.json()).url).hash.slice("#code=".length);
    };
    const redeem = (code: string, replaces?: string) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code, ...(replaces === undefined ? {} : { replaces }) }),
            }),
            environment,
        );
    const token = async (response: Response) => {
        expect(response.status).toBe(200);
        return v.parse(v.object({ token: v.string() }), await response.json()).token;
    };
    const links = [await share(), await share(), await share()];
    const held = await token(await redeem(v.parse(v.string(), links[0])));

    // Both tabs read the same held access before either redemption finishes.
    const [first, second] = await Promise.all([
        redeem(v.parse(v.string(), links[1]), held).then(token),
        redeem(v.parse(v.string(), links[2]), held).then(token),
    ]);

    expect((await request("/session", held)).status).toBe(401);
    expect((await request("/identity/v1/browser-access", second, { method: "DELETE" })).status).toBe(204);
    for (const code of links) {
        expect((await redeem(code)).status).toBe(410);
    }
    for (const credential of [first, second]) {
        expect((await request("/session", credential)).status).toBe(401);
    }
});
