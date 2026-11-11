import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { NativeSessionTarget, SessionAccessHolder } from "@morty-build/client/protocol";
import { createTestComputerBackend } from "../../../relay-test-support/src/backend-fixture.ts";
import { createTestOwner } from "../../../relay-test-support/src/identity-fixture.ts";
import { IdentityStorage } from "../../src/computer-relay/components/management/storage/identity-storage.ts";
import { SessionAccessSigner } from "../../src/computer-relay/components/runtime/entity/session-access-credential.ts";
import { SessionAccessService } from "../../src/computer-relay/components/runtime/service/session-access-service.ts";
import { DurableObjectDatabase } from "../../src/computer-relay/infra/durable-object-database.ts";
import worker from "../../src/worker/application.ts";
import { computerDirectory, readComputerOwner } from "./computer-directory.ts";

export const ownerOrigin = "https://relay.test";
const ownerEnvironment = () => ({ ...env, APP_ORIGIN: ownerOrigin });
export const ownerRequest = (request: Request) => worker.fetch(request, ownerEnvironment());

const owners = new Map<string, string>();
export async function createOwner() {
    const owner = await createTestOwner(ownerRequest, ownerOrigin, AbortSignal.timeout(10_000));
    owners.set(owner.computerId, owner.token);
    return owner;
}

async function ownerHolder(computerId: string): Promise<SessionAccessHolder> {
    const token = owners.get(computerId);
    if (token === undefined) {
        throw new Error("Expected a publicly created owner");
    }
    return runInDurableObject(env.COMPUTER_RELAY.getByName(computerId), async (_instance, state) => {
        const credential = await new IdentityStorage(
            new DurableObjectDatabase(state.storage),
            computerId,
            await readComputerOwner(env, computerId, AbortSignal.timeout(10_000)),
        ).findCredential(token, Date.now(), AbortSignal.timeout(10_000));
        if (credential === null) {
            throw new Error("Expected active owner access");
        }
        return { kind: "credential", credentialId: credential.credentialId };
    });
}

/** Session protocol scenarios start with an authorized computer and an issued Session credential. */
export async function issueSession(computerId: string, target: NativeSessionTarget) {
    return new SessionAccessService(
        computerDirectory(env),
        new SessionAccessSigner(env.MORTY_SESSION_SIGNING_SECRET),
    ).issue({ kind: "session", computerId, target }, 900, await ownerHolder(computerId), AbortSignal.timeout(10_000));
}

export const computerBackend = (computerId: string) => createTestComputerBackend(env, computerId);
