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
                computerId: v.string(),
                bot: v.object({ botId: v.string() }),
            }),
            await response.json(),
        );
    };

    const lost = await create();
    const retried = await create();

    expect(retried).toEqual(lost);
    const session = await worker.fetch(accountRequest(retried.token, retried.computerId), environment);
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ userId: lost.userId });
});

test("Given a device that opened a link and opens the next one, When the reply is lost and the browser repeats the redemption with the same key, Then it gets the same access back and stays one device", async () => {
    const environment = fixture.environment();
    const owner = await fixture.createAnonymousUser();
    const request = (path: string, token: string, init: RequestInit = {}) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}${path}`, {
                ...init,
                headers: { authorization: `Bearer ${token}`, ...init.headers },
            }),
            environment,
        );
    const share = async () => {
        const shared = await request("/identity/transfers", owner.token, { method: "POST" });
        return new URL(v.parse(v.object({ url: v.string() }), await shared.json()).url).hash.slice(6);
    };
    const redeem = async (code: string, redemptionKey: string, replaces?: string) =>
        await worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code, redemptionKey, ...(replaces === undefined ? {} : { replaces }) }),
            }),
            environment,
        );
    const token = async (response: Response) => {
        expect(response.status).toBe(200);
        return v.parse(v.object({ token: v.string() }), await response.json()).token;
    };
    const held = await token(await redeem(await share(), anonymousCreationKey()));

    const next = await share();
    const redemptionKey = anonymousCreationKey();
    const lost = await token(await redeem(next, redemptionKey, held));
    const repeated = await token(await redeem(next, redemptionKey, held));

    expect(repeated).toBe(lost);
    expect((await request("/session", repeated)).status).toBe(200);
    expect((await request("/session", held)).status).toBe(401);
    const listed = await request("/identity/devices", owner.token);
    expect(v.parse(v.object({ devices: v.array(v.unknown()) }), await listed.json()).devices).toHaveLength(1);
    // The link still adds one device: another browser's redemption is refused.
    expect((await redeem(next, anonymousCreationKey())).status).toBe(410);
});

test("Given a device that shared links before and after renewing its credential, When the owner removes it, Then its unused links cannot restore access while other devices and fresh invitations still work", async () => {
    const environment = fixture.environment();
    const owner = await fixture.createAnonymousUser();
    const request = (path: string, token: string, method = "GET") =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}${path}`, {
                method,
                headers: { authorization: `Bearer ${token}` },
            }),
            environment,
        );
    const share = async (token: string) => {
        const response = await request("/identity/transfers", token, "POST");
        expect(response.status).toBe(201);
        return new URL(v.parse(v.object({ url: v.string() }), await response.json()).url).hash.slice(6);
    };
    const redeem = (code: string, redemptionKey = anonymousCreationKey(), replaces?: string) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code, redemptionKey, ...(replaces === undefined ? {} : { replaces }) }),
            }),
            environment,
        );
    const tokenOf = async (response: Response) => {
        expect(response.status).toBe(200);
        return v.parse(v.object({ token: v.string() }), await response.json()).token;
    };
    const original = await tokenOf(await redeem(await share(owner.token)));
    const listed = v.parse(
        v.object({ devices: v.array(v.object({ id: v.string() })) }),
        await (await request("/identity/devices", owner.token)).json(),
    );
    const device = listed.devices[0];
    if (device === undefined) {
        throw new Error("Missing joined device");
    }
    const unusedBeforeRenewal = await share(original);
    const openedAfterRenewal = await share(original);
    const renewed = await tokenOf(await redeem(await share(owner.token), anonymousCreationKey(), original));
    expect((await request("/session", original)).status).toBe(401);
    // Credential replacement does not end the sharing device's access or invalidate its invitations.
    const childRedemptionKey = anonymousCreationKey();
    const child = await tokenOf(await redeem(openedAfterRenewal, childRedemptionKey));
    const unusedAfterRenewal = await share(renewed);
    const independentInvitation = await share(owner.token);

    const removed = await request(`/identity/v1/devices/${device.id}`, owner.token, "DELETE");
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ sessionAccess: "revoked" });
    expect((await request("/session", renewed)).status).toBe(401);
    expect((await redeem(unusedBeforeRenewal)).status).toBe(410);
    expect((await redeem(unusedAfterRenewal)).status).toBe(410);
    expect((await request(`/identity/v1/devices/${device.id}`, owner.token, "DELETE")).status).toBe(200);

    // Already joined devices keep their own grants, including a retry whose first redemption reply was lost.
    expect((await request("/session", child)).status).toBe(200);
    expect(await tokenOf(await redeem(openedAfterRenewal, childRedemptionKey))).toBe(child);
    expect((await request("/session", await tokenOf(await redeem(independentInvitation)))).status).toBe(200);
    const rejoined = await tokenOf(await redeem(await share(owner.token), anonymousCreationKey(), renewed));
    expect((await request("/session", rejoined)).status).toBe(200);
    expect((await redeem(unusedBeforeRenewal)).status).toBe(410);
    expect((await redeem(unusedAfterRenewal)).status).toBe(410);
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
        const identity = v.parse(v.object({ token: v.string(), computerId: v.string() }), await created.json());
        const projectRequest = () =>
            new Request(`${APP_ORIGIN}/morty/api/computers/${identity.computerId}/management/computer`, {
                headers: { authorization: `Bearer ${identity.token}` },
            });
        const response = await worker.fetch(projectRequest(), environment);
        expect(response.status).toBe(200);
        const initial = v.parse(v.object({ computer: v.object({ computerId: v.string() }) }), await response.json());
        const projectCode = { apac: "ap", "apac-ne": "an", "apac-se": "as", wnam: "wn" }[region];
        expect(initial.computer.computerId).toMatch(new RegExp(`^prj_${projectCode}_01_`));
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
        const identity = v.parse(v.object({ computerId: v.string() }), await response.json());
        expect(identity.computerId).toMatch(new RegExp(`^prj_${projectCode}_01_`, "u"));
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
    const identitySchema = v.object({ userId: v.string(), computerId: v.string(), token: v.string() });
    const asian = await worker.fetch(new RegionalRequest("AS"), environment);
    const american = await worker.fetch(new RegionalRequest("NA"), environment);
    expect(asian.status).toBe(201);
    expect(american.status).toBe(201);
    const apac = v.parse(identitySchema, await asian.json());
    const wnam = v.parse(identitySchema, await american.json());
    const sameRegionResponse = await worker.fetch(new RegionalRequest("AS"), environment);
    expect(sameRegionResponse.status).toBe(201);
    const sameRegion = v.parse(identitySchema, await sameRegionResponse.json());
    expect((await worker.fetch(accountRequest(apac.token, sameRegion.computerId), environment)).status).toBe(401);
    expect((await worker.fetch(accountRequest(apac.token), environment)).status).toBe(401);
    for (const [identity, other] of [
        [apac, wnam],
        [wnam, apac],
    ]) {
        if (identity === undefined || other === undefined) {
            throw new Error("Missing identity fixture");
        }
        const session = await worker.fetch(accountRequest(identity.token, identity.computerId), environment);
        expect(session.status).toBe(200);
        expect(await session.json()).toMatchObject({ userId: identity.userId });
        expect((await worker.fetch(accountRequest(identity.token, other.computerId), environment)).status).toBe(401);
        const transfer = await worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/computers/${identity.computerId}/identity/transfers`, {
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
        expect(await redeemed.json()).toMatchObject({ userId: identity.userId, computerId: identity.computerId });
        // A link adds one device.
        expect((await redeem()).status).toBe(410);
    }
});

test("Given a first-time visitor, When their identity and Bot are managed, Then both persist behind the Project boundary", async () => {
    const identity = await fixture.createAnonymousUser();
    const response = await worker.fetch(accountRequest(identity.token, identity.computerId), fixture.environment());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
        authentication: { kind: "anonymous" },
        userId: identity.userId,
        accessExpiresAt: null,
    });
    const served = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/computers/${identity.computerId}/management/bot`, {
            headers: { authorization: `Bearer ${identity.token}` },
        }),
        fixture.environment(),
    );
    expect(served.status).toBe(200);
    const bot = v.parse(v.object({ botId: v.string(), computerId: v.null() }), await served.json());
    const persisted = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/computers/${identity.computerId}/management/bots/${bot.botId}`, {
            headers: { authorization: `Bearer ${identity.token}` },
        }),
        fixture.environment(),
    );
    expect(await persisted.json()).toEqual({
        botId: bot.botId,
        configured: false,
        displayName: "My Machine",
    });
    const projectResponse = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/computers/${identity.computerId}/management/computer`, {
            headers: { authorization: `Bearer ${identity.token}` },
        }),
        fixture.environment(),
    );
    const { computer } = v.parse(
        v.object({ computer: v.object({ computerId: v.string() }) }),
        await projectResponse.json(),
    );
    expect(identity.computerId).toBe(computer.computerId);
    expect(identity.token).toMatch(/^morty_anon_v1_[A-Za-z0-9_-]{43}$/u);
    // A Project that was never created is not found, whichever credential asks for it.
    expect(
        (await worker.fetch(accountRequest(identity.token, `prj_wn_01_${"z".repeat(24)}`), fixture.environment()))
            .status,
    ).toBe(404);
});

test("Given a user with a draft Bot on a Project-scoped Platform, When setup lists Runtimes, Then the available Runtime options are returned", async () => {
    const environment = fixture.environment();
    const identity = await fixture.createAnonymousUser();
    const served = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/computers/${identity.computerId}/management/bot`, {
            headers: { authorization: `Bearer ${identity.token}` },
        }),
        environment,
    );
    const { botId } = v.parse(v.object({ botId: v.string() }), await served.json());
    const response = await fetchPublicApplication(
        new Request(`${APP_ORIGIN}/morty/api/chat/computers/${identity.computerId}/bots/${botId}/setup/runtimes`, {
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

test("Given an anonymous user, When machine access is shared, Then the link adds one device within ten minutes and that device keeps access for a day until it ends it", async () => {
    const environment = fixture.environment();
    const owner = await fixture.createAnonymousUser();
    const created = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}/identity/transfers`, {
            method: "POST",
            headers: { authorization: `Bearer ${owner.token}` },
        }),
        environment,
    );
    expect(created.status).toBe(201);
    const transfer = v.parse(
        v.object({
            url: v.string(),
            expiresAt: v.pipe(v.string(), v.isoTimestamp()),
            accessExpiresAt: v.pipe(v.string(), v.isoTimestamp()),
        }),
        await created.json(),
    );
    // Both terms start when the link is created: ten minutes to open it, a day of access for the device it adds.
    expect(Date.parse(transfer.accessExpiresAt) - Date.parse(transfer.expiresAt)).toBe(
        24 * 60 * 60 * 1000 - 10 * 60 * 1000,
    );
    const redeem = () =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code: new URL(transfer.url).hash.slice("#code=".length) }),
            }),
            environment,
        );

    const opened = await redeem();
    expect(opened.status).toBe(200);
    const device = v.parse(v.object({ token: v.string() }), await opened.json()).token;
    const reused = await redeem();
    expect(reused.status).toBe(410);
    expect(await reused.json()).toMatchObject({
        error: { code: "TRANSFER_UNAVAILABLE", message: "This link was already used, has expired, or was revoked." },
    });
    expect((await worker.fetch(accountRequest(device, owner.computerId), environment)).status).toBe(200);

    const recoveryResponse = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}/identity/recovery-token`, {
            method: "POST",
            headers: { authorization: `Bearer ${owner.token}` },
        }),
        environment,
    );
    expect(recoveryResponse.status).toBe(201);
    const recoveryToken = v.parse(
        v.object({ token: v.pipe(v.string(), v.startsWith("morty_recovery_v1.")) }),
        await recoveryResponse.json(),
    ).token;
    const ended = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}/identity/v1/browser-access`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${device}` },
        }),
        environment,
    );
    expect(ended.status).toBe(204);
    expect((await worker.fetch(accountRequest(device, owner.computerId), environment)).status).toBe(401);
    expect((await worker.fetch(accountRequest(recoveryToken, owner.computerId), environment)).status).toBe(200);
    expect((await worker.fetch(accountRequest(owner.token, owner.computerId), environment)).status).toBe(200);
});

test("Given an anonymous user with a Machine, When a transfer link is redeemed, Then the redemption returns the user's Bot", async () => {
    const environment = fixture.environment();
    const identity = await fixture.createAnonymousUser();
    const servedResponse = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/computers/${identity.computerId}/management/bot`, {
            headers: { authorization: `Bearer ${identity.token}` },
        }),
        environment,
    );
    expect(servedResponse.status).toBe(200);
    const served = v.parse(v.object({ botId: v.string() }), await servedResponse.json());
    const transfer = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/computers/${identity.computerId}/identity/transfers`, {
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
        computerId: identity.computerId,
        botId: served.botId,
    });
});

test("Given the first browser for Morty, When it retires its local credential after a recovery token is created, Then that credential is revoked and recovery remains available", async () => {
    const environment = fixture.environment();
    const identity = await fixture.createAnonymousUser();
    const recoveryResponse = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/computers/${identity.computerId}/identity/recovery-token`, {
            method: "POST",
            headers: { authorization: `Bearer ${identity.token}` },
        }),
        environment,
    );
    expect(recoveryResponse.status).toBe(201);
    const recoveryToken = v.parse(v.object({ token: v.string() }), await recoveryResponse.json()).token;

    const ended = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/computers/${identity.computerId}/identity/v1/local-credential`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${identity.token}` },
        }),
        environment,
    );

    expect(ended.status).toBe(204);
    expect((await worker.fetch(accountRequest(identity.token, identity.computerId), environment)).status).toBe(401);
    expect((await worker.fetch(accountRequest(recoveryToken, identity.computerId), environment)).status).toBe(200);
});

test("Given anonymous Morty sessions, When the account endpoint authenticates them, Then only valid active identities are disclosed", async () => {
    const unauthenticated = await worker.fetch(accountRequest(), {});
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    for (const token of ["morty_anon_v1_invalid", "user_alice"]) {
        expect((await worker.fetch(accountRequest(token), fixture.baseConfiguration)).status).toBe(401);
    }
    const environment = fixture.environment();
    const local = await fixture.createAnonymousUser();
    const response = await worker.fetch(accountRequest(local.token, local.computerId), environment);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
        authentication: { kind: "anonymous" },
        userId: local.userId,
        accessExpiresAt: null,
    });
});

test("Given browser access the owner revoked, When the browser presents its credential, Then the Worker reports that its access ended instead of an unknown credential", async () => {
    const environment = fixture.environment();
    const owner = await fixture.createAnonymousUser();
    const transfer = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}/identity/transfers`, {
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
        new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}/identity/revoke-all-access`, {
            method: "POST",
            headers: { authorization: `Bearer ${owner.token}` },
        }),
        environment,
    );
    expect(revoked.status).toBe(200);
    const management = (token: string) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}/management/bot`, {
                headers: { authorization: `Bearer ${token}` },
            }),
            environment,
        );
    const unknownToken = `morty_anon_v1_${"A".repeat(43)}`;

    // Released pages read the status and code, which stay as they were.
    for (const response of [
        await worker.fetch(accountRequest(browser, owner.computerId), environment),
        await management(browser),
    ]) {
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({
            error: { code: "UNAUTHENTICATED", message: "Access to this computer has ended.", reason: "ACCESS_REVOKED" },
        });
    }
    for (const response of [
        await worker.fetch(accountRequest(unknownToken, owner.computerId), environment),
        await management(unknownToken),
    ]) {
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } });
    }
    expect((await worker.fetch(accountRequest(owner.token, owner.computerId), environment)).status).toBe(200);
});

test("Given a browser that opened one link, When it opens another link for the same user and later ends its access, Then its earlier credential stops at once while another device keeps its own access", async () => {
    const environment = fixture.environment();
    const owner = await fixture.createAnonymousUser();
    const request = (path: string, token: string, init: RequestInit = {}) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}${path}`, {
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
    const phone = await opened(await share());
    const earlier = await opened(firstLink);

    const later = await opened(secondLink, earlier);

    // The browser keeps one credential: the one it opened the later link with replaces the earlier one.
    expect((await request("/session", earlier)).status).toBe(401);
    expect((await request("/session", later)).status).toBe(200);
    expect((await request("/session", phone)).status).toBe(200);

    expect((await request("/identity/v1/browser-access", later, { method: "DELETE" })).status).toBe(204);

    // Ending this browser's access ends what it joined through; each link added one device, so others keep theirs.
    for (const code of [firstLink, secondLink]) {
        expect((await redeem(code)).status).toBe(410);
    }
    expect((await request("/session", later)).status).toBe(401);
    expect((await request("/session", phone)).status).toBe(200);
    expect((await request("/session", owner.token)).status).toBe(200);
});

test("Given a device with a month of access, When it opens a link that grants less, Then it keeps its month, in its session, the device list and what it can share", async () => {
    const environment = fixture.environment();
    const owner = await fixture.createAnonymousUser();
    const request = (path: string, token: string, init: RequestInit = {}) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}${path}`, {
                ...init,
                headers: { authorization: `Bearer ${token}`, ...init.headers },
            }),
            environment,
        );
    const share = async (token: string, accessDuration: string) => {
        const response = await request("/identity/transfers", token, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ accessDuration }),
        });
        expect(response.status).toBe(201);
        const link = v.parse(v.object({ url: v.string(), accessExpiresAt: v.string() }), await response.json());
        return { code: new URL(link.url).hash.slice("#code=".length), accessExpiresAt: link.accessExpiresAt };
    };
    const opened = async (code: string, device: string, replaces?: string) => {
        const response = await worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code, device, ...(replaces === undefined ? {} : { replaces }) }),
            }),
            environment,
        );
        expect(response.status).toBe(200);
        return v.parse(v.object({ token: v.string() }), await response.json()).token;
    };
    const term = async (token: string) =>
        v.parse(v.object({ accessExpiresAt: v.string() }), await (await request("/session", token)).json())
            .accessExpiresAt;
    const listed = async () =>
        v.parse(
            v.object({
                devices: v.array(v.object({ label: v.nullable(v.string()), accessExpiresAt: v.string() })),
            }),
            await (await request("/identity/devices", owner.token)).json(),
        ).devices;

    const month = await share(owner.token, "30d");
    const phone = await opened(month.code, "iPhone · Safari");
    const guest = await opened((await share(owner.token, "1h")).code, "Guest · Chrome");
    // The guest's link is capped at the guest's own hour.
    const guestLink = await share(guest, "30d");
    expect(Date.parse(guestLink.accessExpiresAt)).toBeLessThan(Date.parse(month.accessExpiresAt));

    const reopened = await opened(guestLink.code, "iPhone · Safari", phone);

    expect((await request("/session", phone)).status).toBe(401);
    expect(await term(reopened)).toBe(month.accessExpiresAt);
    expect((await listed()).filter((device) => device.label === "iPhone · Safari")).toStrictEqual([
        { label: "iPhone · Safari", accessExpiresAt: month.accessExpiresAt },
    ]);
    expect((await share(reopened, "30d")).accessExpiresAt).toBe(month.accessExpiresAt);

    // Ending the device's access still ends it at once.
    expect((await request("/identity/v1/browser-access", reopened, { method: "DELETE" })).status).toBe(204);
    expect((await request("/session", reopened)).status).toBe(401);
});

test("Given two tabs of one browser open new links at once, When the browser later ends its access from either tab, Then every link it joined through stops opening Morty", async () => {
    const environment = fixture.environment();
    const owner = await fixture.createAnonymousUser();
    const request = (path: string, token: string, init: RequestInit = {}) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}${path}`, {
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

test("Given browsers that joined through links shared by the computer and by another browser, When one lists the linked devices, Then each other device appears as it first joined and with who shared its link", async () => {
    const environment = fixture.environment();
    const owner = await fixture.createAnonymousUser();
    const request = (path: string, token: string, init: RequestInit = {}) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}${path}`, {
                ...init,
                headers: { authorization: `Bearer ${token}` },
            }),
            environment,
        );
    const join = async (sharer: string, device: string, replaces?: string) => {
        const shared = await request("/identity/transfers", sharer, { method: "POST" });
        const code = new URL(v.parse(v.object({ url: v.string() }), await shared.json()).url).hash.slice(6);
        const redeemed = await worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code, device, ...(replaces === undefined ? {} : { replaces }) }),
            }),
            environment,
        );
        expect(redeemed.status).toBe(200);
        return v.parse(v.object({ token: v.string() }), await redeemed.json()).token;
    };
    const listed = async (token: string) => {
        // Through the public entry, as browsers without the WebSocket bridge and other clients reach it.
        const response = await fetchPublicApplication(
            new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}/identity/devices`, {
                headers: { authorization: `Bearer ${token}` },
            }),
            environment,
        );
        expect(response.status).toBe(200);
        const { devices } = v.parse(
            v.object({
                devices: v.array(
                    v.looseObject({
                        joinedAt: v.pipe(v.string(), v.isoTimestamp()),
                        id: v.string(),
                        accessExpiresAt: v.pipe(v.string(), v.isoTimestamp()),
                    }),
                ),
            }),
            await response.json(),
        );
        return devices.map(({ joinedAt: _joinedAt, id: _id, accessExpiresAt: _term, ...device }) => device);
    };

    const laptop = await join(owner.token, "Mac · Chrome");
    const phone = await join(laptop, "iPhone · Safari");
    // The same browser opening another link stays the device that first joined.
    await join(owner.token, "iPhone · Chrome", phone);

    const phoneAddedByLaptop = {
        label: "iPhone · Safari",
        location: null,
        addedBy: { kind: "device", label: "Mac · Chrome" },
    };
    expect(await listed(laptop)).toEqual([phoneAddedByLaptop]);
    expect(await listed(owner.token)).toEqual([
        { label: "Mac · Chrome", location: null, addedBy: { kind: "computer" } },
        phoneAddedByLaptop,
    ]);
});

test("Given the owner chooses how long a shared device keeps access, When the link is opened or replaced, Then the device keeps exactly that term and only the latest link works", async () => {
    const environment = fixture.environment();
    const owner = await fixture.createAnonymousUser();
    const request = (path: string, token: string, init: RequestInit = {}) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}${path}`, {
                ...init,
                headers: { authorization: `Bearer ${token}`, ...init.headers },
            }),
            environment,
        );
    const share = (body: object) =>
        request("/identity/transfers", owner.token, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
    const link = v.object({
        url: v.string(),
        expiresAt: v.string(),
        accessExpiresAt: v.string(),
        accessDuration: v.string(),
    });
    const codeOf = (url: string) => new URL(url).hash.slice("#code=".length);
    const redeem = (code: string) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code }),
            }),
            environment,
        );

    expect((await share({ accessDuration: "1y" })).status).toBe(400);
    const first = v.parse(link, await (await share({})).json());
    // Without a choice the link grants the default day, and says so: callers show what the Worker applied.
    expect(first.accessDuration).toBe("1d");
    const created = await share({ accessDuration: "7d", replaces: codeOf(first.url) });
    expect(created.status).toBe(201);
    const week = v.parse(link, await created.json());
    expect(week.accessDuration).toBe("7d");
    // The device term runs from the link's creation, a week past the ten minutes the link itself stays open.
    expect(Date.parse(week.accessExpiresAt) - Date.parse(week.expiresAt)).toBe(
        7 * 24 * 60 * 60 * 1000 - 10 * 60 * 1000,
    );

    expect((await redeem(codeOf(first.url))).status).toBe(410);
    const opened = await redeem(codeOf(week.url));
    expect(opened.status).toBe(200);
    const device = v.parse(v.object({ token: v.string() }), await opened.json()).token;
    const session = v.parse(
        v.object({ accessExpiresAt: v.string() }),
        await (await request("/session", device)).json(),
    );
    expect(session.accessExpiresAt).toBe(week.accessExpiresAt);
});

test("Given two devices that joined through links, When one disconnects the other, Then only that device loses access, retrying is harmless, no device can disconnect itself and the other rejoins only as a new device", async () => {
    const environment = fixture.environment();
    const owner = await fixture.createAnonymousUser();
    const request = (path: string, token: string, init: RequestInit = {}) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}${path}`, {
                ...init,
                headers: { authorization: `Bearer ${token}`, ...init.headers },
            }),
            environment,
        );
    const join = async (device: string, replaces?: string) => {
        const shared = await request("/identity/transfers", owner.token, { method: "POST" });
        const code = new URL(v.parse(v.object({ url: v.string() }), await shared.json()).url).hash.slice(6);
        const opened = await worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code, device, ...(replaces === undefined ? {} : { replaces }) }),
            }),
            environment,
        );
        return v.parse(v.object({ token: v.string() }), await opened.json()).token;
    };
    const devices = async (token: string) =>
        v.parse(
            v.object({
                devices: v.array(v.object({ id: v.string(), joinedAt: v.string(), label: v.nullable(v.string()) })),
            }),
            await (await request("/identity/devices", token)).json(),
        ).devices;
    const phone = await join("iPhone · Safari");
    const laptop = await join("macOS · Chrome");
    const laptopId = (await devices(phone)).find((device) => device.label === "macOS · Chrome")?.id ?? "";
    const phoneId = (await devices(laptop)).find((device) => device.label === "iPhone · Safari")?.id ?? "";

    const ended = await request(`/identity/v1/devices/${laptopId}`, phone, { method: "DELETE" });

    expect(ended.status).toBe(200);
    expect((await request("/session", laptop)).status).toBe(401);
    expect((await request("/session", phone)).status).toBe(200);
    expect((await request("/session", owner.token)).status).toBe(200);
    expect((await devices(phone)).map((device) => device.label)).toEqual([]);
    expect((await request(`/identity/v1/devices/${laptopId}`, phone, { method: "DELETE" })).status).toBe(200);
    expect((await request(`/identity/v1/devices/${phoneId}`, phone, { method: "DELETE" })).status).toBe(409);
    expect((await request("/session", phone)).status).toBe(200);

    // The disconnected browser opens a later link with the credential it still stores: it joins as a new device, so
    // the phone is told about it again.
    const rejoined = await join("macOS · Chrome", laptop);
    expect((await request("/session", rejoined)).status).toBe(200);
    expect(await devices(phone)).toEqual([
        { id: expect.not.stringMatching(laptopId), joinedAt: expect.any(String), label: "macOS · Chrome" },
    ]);
});

test("Given a browser whose credential a later link replaced, When a stale tab opens a link with the replaced credential and another device later ends that browser's device, Then the browser stays one device until then and rejoins only as a new one", async () => {
    const environment = fixture.environment();
    const owner = await fixture.createAnonymousUser();
    const request = (path: string, token: string, init: RequestInit = {}) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/computers/${owner.computerId}${path}`, {
                ...init,
                headers: { authorization: `Bearer ${token}`, ...init.headers },
            }),
            environment,
        );
    const join = async (device: string, replaces?: string) => {
        const shared = await request("/identity/transfers", owner.token, { method: "POST" });
        const code = new URL(v.parse(v.object({ url: v.string() }), await shared.json()).url).hash.slice(6);
        const opened = await worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code, device, ...(replaces === undefined ? {} : { replaces }) }),
            }),
            environment,
        );
        expect(opened.status).toBe(200);
        return v.parse(v.object({ token: v.string() }), await opened.json()).token;
    };
    const devices = async (token: string) =>
        v.parse(
            v.object({ devices: v.array(v.object({ id: v.string(), label: v.nullable(v.string()) })) }),
            await (await request("/identity/devices", token)).json(),
        ).devices;
    const refusedAsEnded = async (token: string) => {
        const response = await request("/session", token);
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({
            error: { code: "UNAUTHENTICATED", message: "Access to this computer has ended.", reason: "ACCESS_REVOKED" },
        });
    };
    const phone = await join("iPhone · Safari");
    const first = await join("macOS · Chrome");
    const laptopId = (await devices(phone)).find((device) => device.label === "macOS · Chrome")?.id ?? "";
    const later = await join("macOS · Chrome", first);

    // A tab that still holds the replaced credential opens another link: the device still holds access, so the
    // browser stays the same device.
    const stale = await join("macOS · Chrome", first);

    await refusedAsEnded(first);
    for (const token of [later, stale]) {
        expect((await request("/session", token)).status).toBe(200);
    }
    expect(await devices(phone)).toEqual([{ id: laptopId, label: "macOS · Chrome" }]);

    expect((await request(`/identity/v1/devices/${laptopId}`, phone, { method: "DELETE" })).status).toBe(200);

    for (const token of [first, later, stale]) {
        await refusedAsEnded(token);
    }
    expect(await devices(phone)).toEqual([]);
    const rejoined = await join("macOS · Chrome", first);
    expect((await request("/session", rejoined)).status).toBe(200);
    expect(await devices(phone)).toEqual([{ id: expect.not.stringMatching(laptopId), label: "macOS · Chrome" }]);
});
