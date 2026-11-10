import { env } from "cloudflare:workers";
import type { NativeSessionTarget } from "@morty-build/client/protocol";
import { createTestComputerBackend } from "../../relay-test-support/src/backend-fixture.ts";
import { createTestOwner } from "../../relay-test-support/src/identity-fixture.ts";
import worker from "../../worker/src/application.ts";
import { createRelayAccessServices } from "../src/relay-worker.ts";

export const ownerOrigin = "https://relay.test";
export const ownerEnvironment = () => ({ ...env, APP_ORIGIN: ownerOrigin });
export const ownerRequest = (request: Request) => worker.fetch(request, ownerEnvironment());

export async function createOwner() {
    return createTestOwner(ownerRequest, ownerOrigin, AbortSignal.timeout(10_000));
}

/** Session protocol scenarios start with an authorized computer and an issued Session credential. */
export async function issueSession(computerId: string, target: NativeSessionTarget) {
    return createRelayAccessServices(env).sessionAccess.issue(
        { kind: "session", computerId, target },
        900,
        AbortSignal.timeout(10_000),
    );
}

export const computerBackend = (computerId: string) => createTestComputerBackend(env, computerId);
