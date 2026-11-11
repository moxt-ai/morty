import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import * as v from "valibot";
import { memoryComputerCredentials } from "../packages/cli/tests/support/computer-credentials.ts";
import { connectControlledAgentRuntime, createMortyFakeDaemon } from "../tests/support/fake-daemon/runtime.ts";
import { mortyReply } from "../tests/support/fake-daemon/scenarios.ts";

const targets = v.parse(
    v.object({ environments: v.object({ production: v.object({ morty_origin: v.string() }) }) }),
    JSON.parse(await readFile(new URL("./targets.json", import.meta.url), "utf8")),
);
const { values } = parseArgs({
    options: {
        origin: { type: "string", default: targets.environments.production.morty_origin },
        evidence: { type: "string", default: "session-access-evidence.json" },
    },
});
const origin = new URL(values.origin);
if (
    origin.origin !== values.origin ||
    (origin.origin !== targets.environments.production.morty_origin &&
        !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))
) {
    throw new Error("Verification may only target Morty production or an isolated local Worker");
}
const signingSecret = v.parse(v.pipe(v.string(), v.minLength(32)), process.env["MORTY_SESSION_SIGNING_SECRET"]);
const signal = AbortSignal.timeout(120_000);

async function request(path: string, status: number, token?: string, body?: object): Promise<unknown> {
    const response = await fetch(new URL(path, origin), {
        method: body === undefined ? "GET" : "POST",
        headers: {
            "content-type": "application/json",
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
        redirect: "error",
    });
    if (response.status !== status) {
        await response.body?.cancel();
        throw new Error(`Morty verification failed (${path}, HTTP ${response.status})`);
    }
    return await response.json();
}

const owner = v.parse(
    v.object({ token: v.string(), computerId: v.string() }),
    await request("/morty/api/identity/anonymous-users", 201, undefined, {
        creationKey: randomBytes(32).toString("base64url"),
    }),
);
const pairing = v.parse(
    v.object({ pairingCode: v.string() }),
    await request(`/morty/api/computers/${owner.computerId}/management/pairing`, 201, owner.token, {
        idempotencyKey: `verification-${randomBytes(16).toString("hex")}`,
    }),
);
const behavior = { harness: "codex", agentName: "Controlled verification Agent", reply: mortyReply };
const harness = createMortyFakeDaemon(behavior);
const claim = v.parse(
    v.object({ computerCredential: v.string() }),
    await request(`/morty/api/v1/pairings/${owner.computerId}/redeem`, 200, undefined, {
        pairingCode: pairing.pairingCode,
        machineName: "Deployment verification",
        workspaceName: "Isolated verification",
        agents: harness.catalog,
    }),
);
await using _runtime = await connectControlledAgentRuntime({
    behavior,
    signal,
    connection: {
        computerId: owner.computerId,
        origin: origin.origin,
        credentials: memoryComputerCredentials(claim.computerCredential),
    },
});
const chat = `/morty/api/chat/computers/${owner.computerId}`;
await request(`${chat}/setup`, 202, owner.token, { computerId: owner.computerId, harness: "codex" });
const access = v.parse(
    v.object({ credential: v.string(), target: v.object({ harness: v.string(), sessionId: v.string() }) }),
    await request(`${chat}/access`, 200, owner.token, {
        harness: "codex",
        conversationKey: `verification-${randomBytes(16).toString("hex")}`,
        workspaceRef: ".",
        configurations: [],
    }),
);
const credential = /^msession_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u.exec(access.credential);
const payload = credential?.[1];
const signature = credential?.[2];
if (payload === undefined || signature === undefined) {
    throw new Error("Invalid issued Session credential");
}
const signed = `msession_${payload}`;
const expected = createHmac("sha256", signingSecret).update(signed).digest();
if (!timingSafeEqual(expected, Buffer.from(signature, "base64url"))) {
    throw new Error("The configured signing key was not used");
}
const sessionPath = `/morty/api/v1/computers/${owner.computerId}/harnesses/${access.target.harness}/sessions/${access.target.sessionId}`;
await request(`${sessionPath}/live-event-subscription-target`, 200, access.credential);
await request(
    `${sessionPath}/live-event-subscription-target`,
    401,
    `${signed}.${Buffer.alloc(32).toString("base64url")}`,
);
for (const path of [
    "/morty/api/dashboard/health",
    "/morty/api/dashboard/v1/machine-accounts",
    `/morty/api/v1/computers/${owner.computerId}/daemon/agents`,
]) {
    await request(path, 404);
}
const successor = `morty_anon_v1_${randomBytes(32).toString("base64url")}`;
await request(`/morty/api/computers/${owner.computerId}/identity/revoke-all-access`, 200, owner.token, { successor });
await request(`${sessionPath}/live-event-subscription-target`, 401, access.credential);
const renewed = v.parse(
    v.object({ credential: v.string() }),
    await request(`${chat}/session-access`, 200, successor, access.target),
);
await request(`${sessionPath}/live-event-subscription-target`, 200, renewed.credential);
await writeFile(
    values.evidence,
    `${JSON.stringify(
        {
            passed: true,
            architecture: "single-worker",
            revision: process.env["EXPECTED_REVISION"],
            configuredSigningKeyVerified: true,
            runtimeVerificationStatus: 200,
            forgeryStatus: 401,
            retiredEndpointsStatus: 404,
            endedHolderStatus: 401,
            successorHolderStatus: 200,
            agent: "controlled ACP harness; not vendor-Agent compatibility evidence",
        },
        null,
        2,
    )}\n`,
);
console.log(JSON.stringify({ passed: true, architecture: "single-worker" }));
