import * as v from "valibot";
import { afterEach, beforeEach, expect, test } from "vitest";
import worker from "../src/application.ts";
import { APP_ORIGIN, clerk as issuer } from "./support/clerk.ts";
import { accountRequest, createIdentityFixture } from "./support/identity-fixture.ts";

let fixture: Awaited<ReturnType<typeof createIdentityFixture>>;

beforeEach(async () => {
    fixture = await createIdentityFixture();
});

afterEach(async () => {
    await fixture.close();
});

test("Given visitors across Cloudflare regions, When Chat provisions and reopens workspaces, Then Platform preserves every placement", async () => {
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
            new GeolocatedRequest(
                new Request(`${APP_ORIGIN}/mobius-cloud/api/identity/anonymous-users`, {
                    method: "POST",
                    headers: { "cf-ipcountry": "US" },
                }),
                continent,
                country,
            ),
            environment,
        );
        expect(created.status).toBe(201);
        const identity = v.parse(v.object({ token: v.string(), projectId: v.string() }), await created.json());
        const projectRequest = () =>
            new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${identity.projectId}/management/project`, {
                headers: { authorization: `Bearer ${identity.token}` },
            });
        const response = await worker.fetch(projectRequest(), environment);
        expect(response.status).toBe(200);
        const initial = v.parse(v.object({ project: v.object({ projectId: v.string() }) }), await response.json());
        const projectCode = { apac: "ap", "apac-ne": "an", "apac-se": "as", wnam: "wn" }[region];
        expect(initial.project.projectId).toMatch(new RegExp(`^prj_${projectCode}_01_`));
        const revisited = await worker.fetch(
            new GeolocatedRequest(
                new Request(projectRequest(), {
                    method: "POST",
                    headers: {
                        authorization: `Bearer ${identity.token}`,
                        "content-type": "application/json",
                    },
                    body: JSON.stringify({ displayName: "Personal workspace" }),
                }),
                region === "wnam" ? "AS" : "NA",
                region === "wnam" ? "CN" : "US",
            ),
            environment,
        );
        expect(revisited.status).toBe(200);
        expect(await revisited.json()).toMatchObject(initial);
    }
});

test("Given explicit location choices, When users create workspaces, Then every supported Project code is honored", async () => {
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
            new Request(`${APP_ORIGIN}/mobius-cloud/api/identity/anonymous-users`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ locationHint }),
            }),
            fixture.environment(),
        );

        expect(response.status).toBe(201);
        const identity = v.parse(v.object({ projectId: v.string() }), await response.json());
        expect(identity.projectId).toMatch(new RegExp(`^prj_${projectCode}_01_`, "u"));
    }
});

test("Given Projects in separate regions, When users reopen and transfer their workspaces, Then Project objects retain their identities and reject another Project", async () => {
    const environment = fixture.environment();
    class RegionalRequest extends Request {
        override readonly cf: { readonly continent: string };
        constructor(continent: string) {
            super(`${APP_ORIGIN}/mobius-cloud/api/identity/anonymous-users`, { method: "POST" });
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
            new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${identity.projectId}/identity/transfers`, {
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
                new Request(`${APP_ORIGIN}/mobius-cloud/api/identity/transfers/redeem`, {
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

test("Given a first-time visitor, When their workspace and Bot are managed, Then both persist behind the Project boundary", async () => {
    const identity = await fixture.createAnonymousUser();
    const response = await worker.fetch(accountRequest(identity.token, identity.projectId), fixture.environment());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
        authentication: { kind: "anonymous" },
        userId: identity.userId,
    });
    const bots = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${identity.projectId}/management/bots`, {
            headers: { authorization: `Bearer ${identity.token}` },
        }),
        fixture.environment(),
    );
    expect(bots.status).toBe(200);
    const { bots: availableBots } = v.parse(
        v.object({ bots: v.array(v.object({ botId: v.string(), displayName: v.string() })) }),
        await bots.json(),
    );
    expect(availableBots).toHaveLength(1);
    const bot = v.parse(v.object({ botId: v.string(), displayName: v.literal("My Bot") }), availableBots[0]);
    const updated = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${identity.projectId}/management/bots/${bot.botId}`, {
            method: "PATCH",
            headers: { authorization: `Bearer ${identity.token}`, "content-type": "application/json" },
            body: JSON.stringify({
                displayName: "Research Assistant",
                instructions: "Cite the source for every factual claim.",
            }),
        }),
        fixture.environment(),
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
        botId: bot.botId,
        configured: false,
        displayName: "Research Assistant",
        instructions: "Cite the source for every factual claim.",
    });
    const persisted = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${identity.projectId}/management/bots/${bot.botId}`, {
            headers: { authorization: `Bearer ${identity.token}` },
        }),
        fixture.environment(),
    );
    expect(await persisted.json()).toMatchObject({
        botId: bot.botId,
        displayName: "Research Assistant",
        instructions: "Cite the source for every factual claim.",
    });
    const projectResponse = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${identity.projectId}/management/project`, {
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

test("Given a user with multiple Bots, When they remove one Bot, Then the other remains and the last Bot cannot be removed", async () => {
    const identity = await fixture.createAnonymousUser();
    const environment = fixture.environment();
    const botsUrl = `${APP_ORIGIN}/mobius-cloud/api/projects/${identity.projectId}/management/bots`;
    const headers = { authorization: `Bearer ${identity.token}` };
    const initialResponse = await worker.fetch(new Request(botsUrl, { headers }), environment);
    const initial = v.parse(
        v.object({ bots: v.array(v.object({ botId: v.string(), displayName: v.string() })) }),
        await initialResponse.json(),
    ).bots;
    const original = v.parse(v.object({ botId: v.string() }), initial[0]);

    const blocked = await worker.fetch(
        new Request(`${botsUrl}/${original.botId}`, { method: "DELETE", headers }),
        environment,
    );
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: "LAST_BOT_REQUIRED" } });

    const createdResponse = await worker.fetch(
        new Request(botsUrl, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ displayName: "Laptop Bot" }),
        }),
        environment,
    );
    const created = v.parse(v.object({ botId: v.string() }), await createdResponse.json());
    const removed = await worker.fetch(
        new Request(`${botsUrl}/${created.botId}`, { method: "DELETE", headers }),
        environment,
    );
    expect(removed.status).toBe(204);

    const remainingResponse = await worker.fetch(new Request(botsUrl, { headers }), environment);
    expect(await remainingResponse.json()).toEqual({ bots: initial });
});

test("Given a user with a Bot on a Project-scoped Platform, When setup checks the Bot workspace, Then the draft Bot and available agents are returned", async () => {
    const environment = fixture.environment();
    const identity = await fixture.createAnonymousUser();
    const listed = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${identity.projectId}/management/bots`, {
            headers: { authorization: `Bearer ${identity.token}` },
        }),
        environment,
    );
    const { bots } = v.parse(v.object({ bots: v.array(v.object({ botId: v.string() })) }), await listed.json());
    const response = await worker.fetch(
        new Request(
            `${APP_ORIGIN}/mobius-cloud/api/chat/projects/${identity.projectId}/bots/${bots[0]?.botId}/workspace`,
            {
                method: "POST",
                headers: {
                    authorization: `Bearer ${identity.token}`,
                    "content-type": "application/json",
                },
                body: "{}",
            },
        ),
        environment,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "draft", selected: null, agents: [] });
});

test("Given an anonymous user, When access is transferred, revoked, and exhausted, Then every credential follows the lifecycle", async () => {
    const environment = fixture.environment();
    const owner = await fixture.createAnonymousUser();
    const createTransfer = async () => {
        const response = await worker.fetch(
            new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${owner.projectId}/identity/transfers`, {
                method: "POST",
                headers: { authorization: `Bearer ${owner.token}` },
            }),
            environment,
        );
        expect(response.status).toBe(201);
        const transfer = v.parse(v.object({ url: v.string(), expiresAt: v.string() }), await response.json());
        return { ...transfer, code: new URL(transfer.url).hash.slice("#code=".length) };
    };
    const redeem = (code: string) =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/mobius-cloud/api/identity/transfers/redeem`, {
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
    const ended = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${owner.projectId}/identity/remote-access`, {
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
    expect((await worker.fetch(accountRequest(owner.token, owner.projectId), environment)).status).toBe(200);

    const limitedTransfer = await createTransfer();
    expect(Date.parse(limitedTransfer.expiresAt)).toBeGreaterThan(Date.now());
    const issuedTokens = [];
    for (let redemption = 0; redemption < 5; redemption++) {
        const response = await redeem(limitedTransfer.code);
        expect(response.status).toBe(200);
        const received = v.parse(
            v.object({ userId: v.string(), token: v.pipe(v.string(), v.startsWith("mobius_anon_v2_")) }),
            await response.json(),
        );
        expect(received.userId).toBe(owner.userId);
        issuedTokens.push(received.token);
    }
    expect(new Set(issuedTokens).size).toBe(5);
    const exhausted = await redeem(limitedTransfer.code);
    expect(exhausted.status).toBe(410);
    expect(await exhausted.json()).toMatchObject({ error: { code: "TRANSFER_UNAVAILABLE" } });
});

test("Given anonymous and signed-in users with Bots, When pairing tickets are issued and redeemed, Then ownership and one-time use are enforced", async () => {
    const environment = fixture.environment();
    const foreign = await fixture.createAnonymousUser();

    for (const kind of ["anonymous", "clerk"] as const) {
        const identity = await fixture.createAnonymousUser();
        const token = kind === "anonymous" ? identity.token : issuer.createSession(`user_pair_${kind}`, APP_ORIGIN);
        if (kind === "clerk") {
            const bound = await worker.fetch(
                new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${identity.projectId}/identity/clerk-binding`, {
                    method: "POST",
                    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                    body: JSON.stringify({ action: "bind", anonymousToken: identity.token }),
                }),
                environment,
            );
            expect(bound.status).toBe(200);
        }

        const session = await worker.fetch(accountRequest(token, identity.projectId), environment);
        const { userId } = v.parse(v.object({ userId: v.string() }), await session.json());
        const botsResponse = await worker.fetch(
            new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${identity.projectId}/management/bots`, {
                headers: { authorization: `Bearer ${token}` },
            }),
            environment,
        );
        const { bots } = v.parse(
            v.object({ bots: v.array(v.object({ botId: v.string() })) }),
            await botsResponse.json(),
        );
        const botId = v.parse(v.string(), bots[0]?.botId);

        if (kind === "anonymous") {
            const foreignIssue = await worker.fetch(
                new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${foreign.projectId}/identity/pairings`, {
                    method: "POST",
                    headers: { authorization: `Bearer ${foreign.token}`, "content-type": "application/json" },
                    body: JSON.stringify({ botId }),
                }),
                environment,
            );
            expect(foreignIssue.status).toBe(404);
        }

        const issued = await worker.fetch(
            new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${identity.projectId}/identity/pairings`, {
                method: "POST",
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                body: JSON.stringify({ botId }),
            }),
            environment,
        );
        expect(issued.status).toBe(201);
        const ticket = v.parse(v.object({ url: v.string(), expiresAt: v.string() }), await issued.json());
        expect(Date.parse(ticket.expiresAt)).toBeGreaterThan(Date.now());
        const ticketUrl = new URL(ticket.url);
        expect(ticketUrl.pathname).toBe("/pair.md");
        const pairingToken = ticketUrl.searchParams.get("token");

        const redeem = () =>
            worker.fetch(
                new Request(`${APP_ORIGIN}/mobius-cloud/api/identity/pairings/redeem`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ token: pairingToken }),
                }),
                environment,
            );
        const redeemed = await redeem();
        expect(redeemed.status).toBe(200);
        const local = v.parse(
            v.object({
                token: v.string(),
                userId: v.string(),
                botId: v.string(),
                projectId: v.string(),
                expectedRuntimeId: v.null(),
            }),
            await redeemed.json(),
        );
        expect(local).toMatchObject({ userId, botId, expectedRuntimeId: null });
        expect((await worker.fetch(accountRequest(local.token, local.projectId), environment)).status).toBe(200);
        expect((await redeem()).status).toBe(410);
    }
});

test("Given Clerk configuration and sessions, When public and account endpoints authenticate them, Then only valid active identities are disclosed", async () => {
    const publicConfiguration = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-cloud/api/config`),
        fixture.baseConfiguration,
    );
    expect(publicConfiguration.status).toBe(200);
    expect(await publicConfiguration.json()).toEqual({ publishableKey: issuer.publishableKey });
    expect(publicConfiguration.headers.get("Cache-Control")).toBe("no-store");

    const unauthenticated = await worker.fetch(accountRequest(), {});
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    for (const token of [
        issuer.createSession("user_alice", "https://untrusted.example"),
        issuer.createSession("user_alice", APP_ORIGIN, "pending"),
    ]) {
        expect((await worker.fetch(accountRequest(token), fixture.baseConfiguration)).status).toBe(401);
    }
    const environment = fixture.environment();
    const local = await fixture.createAnonymousUser();
    const clerkToken = issuer.createSession("user_alice", APP_ORIGIN, "active", "org_ignored");
    const bound = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${local.projectId}/identity/clerk-binding`, {
            body: JSON.stringify({ action: "bind", anonymousToken: local.token }),
            headers: { authorization: `Bearer ${clerkToken}`, "content-type": "application/json" },
            method: "POST",
        }),
        environment,
    );
    expect(bound.status).toBe(200);
    const response = await worker.fetch(accountRequest(clerkToken, local.projectId), environment);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
        authentication: { kind: "clerk" },
        userId: local.userId,
        sessionId: expect.stringMatching(/^sess_/),
    });
});
