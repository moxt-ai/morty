import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { NativeSessionTarget, SessionAccessHolder } from "@morty-build/client/protocol";
import { createTestComputerBackend } from "../../relay-test-support/src/backend-fixture.ts";
import { createTestOwner } from "../../relay-test-support/src/identity-fixture.ts";
import worker from "../../worker/src/application.ts";
import { IdentityStorage } from "../../worker/src/components/management/storage/identity-storage.ts";
import { createHostedRelayAccess } from "../../worker/src/composition/relay-services.ts";
import { DurableObjectDatabase } from "../../worker/src/infra/durable-object-database.ts";

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
            await createHostedRelayAccess(env).control.readComputerOwner(computerId, AbortSignal.timeout(10_000)),
        ).findCredential(token, Date.now(), AbortSignal.timeout(10_000));
        if (credential === null) {
            throw new Error("Expected active owner access");
        }
        return { kind: "credential", credentialId: credential.credentialId };
    });
}

/** Session protocol scenarios start with an authorized computer and an issued Session credential. */
export async function issueSession(computerId: string, target: NativeSessionTarget) {
    return createHostedRelayAccess(env).sessionAccess.issue(
        { kind: "session", computerId, target },
        900,
        await ownerHolder(computerId),
        AbortSignal.timeout(10_000),
    );
}

export const computerBackend = (computerId: string) => createTestComputerBackend(env, computerId);
