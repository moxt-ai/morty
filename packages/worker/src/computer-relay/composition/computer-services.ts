import type { SessionAccessHolder } from "@morty-build/client/protocol";
import * as v from "valibot";
import type { CloudBindings } from "../../contracts/cloud-bindings.ts";
import { computerBootstrap } from "../../contracts/computer-bootstrap.ts";
import { relayIdentifier } from "../../contracts/computer-management.ts";
import { ManagementError } from "../../contracts/management-error.ts";
import { ManagedSessionOperations } from "../components/chat/infra/managed-session-operations.ts";
import type { ComputerBackendService } from "../components/computer/service/computer-backend-service.ts";
import { holdsAccess } from "../components/management/service/authentication-service.ts";
import type { IdentityOperations } from "../components/management/service/identity-operations.ts";
import { IdentityStorage } from "../components/management/storage/identity-storage.ts";
import type { DurableObjectDatabase } from "../infra/durable-object-database.ts";
import { readComputerOwner } from "./account-provisioning.ts";
import { type ApplicationContext, createApplicationDependencies } from "./application-context.ts";

/**
 * One computer's storage. Only the computer's bootstrap binds the object and creates its schema; a request for an computer
 * the object does not hold leaves no storage behind.
 */
export class ComputerServices {
    readonly #storage: DurableObjectStorage;
    readonly #owns: (id: string) => boolean;
    readonly #endAccess: IdentityOperations["commitAccessEnd"];
    readonly #runtime: (computerId: string) => ComputerBackendService;
    readonly #database: () => DurableObjectDatabase;
    /** Commits access changes with their connection checks inside the owning object. */
    constructor(
        storage: DurableObjectStorage,
        owns: (id: string) => boolean,
        endAccess: IdentityOperations["commitAccessEnd"],
        runtime: (computerId: string) => ComputerBackendService,
        database: () => DurableObjectDatabase,
    ) {
        this.#storage = storage;
        this.#owns = owns;
        this.#endAccess = endAccess;
        this.#runtime = runtime;
        this.#database = database;
    }

    /** Whether `holder`'s access to this computer holds now; the Relay honors a Session credential only while it does. */
    readonly holdsAccess = async (
        computerId: string,
        holder: SessionAccessHolder,
        env: CloudBindings,
        signal: AbortSignal,
    ): Promise<boolean> => {
        if (!this.#owns(computerId)) {
            throw new Error("Durable Object computer identity does not match the request.");
        }
        return await holdsAccess(
            new IdentityStorage(this.#database(), computerId, await readComputerOwner(env, computerId, signal)),
            holder,
            signal,
        );
    };

    readonly #sessionOperations = new ManagedSessionOperations();

    readonly forComputer = async (
        computerId: string,
        env: CloudBindings,
        signal: AbortSignal,
    ): Promise<ApplicationContext> => {
        signal.throwIfAborted();
        const validatedComputerId = v.parse(relayIdentifier, computerId);
        const bound: unknown = await this.#storage.get("computer-id");
        if (bound === undefined) {
            throw new ManagementError("PROJECT_NOT_FOUND", "The Morty computer does not exist.", 404);
        }
        if (!this.#owns(validatedComputerId) || bound !== validatedComputerId) {
            throw new Error("Durable Object computer identity does not match the request.");
        }
        return await this.#application(validatedComputerId, env, signal);
    };

    readonly bootstrap = async (input: unknown, env: CloudBindings, signal: AbortSignal) => {
        signal.throwIfAborted();
        const parsed = v.parse(computerBootstrap, input);
        await this.#bindComputer(parsed.computer.computerId);
        const dependencies = await this.#application(parsed.computer.computerId, env, signal);
        return await dependencies.services.management.initializeAnonymousUser(
            parsed.userId,
            parsed.computer,
            signal,
            parsed.origin,
        );
    };

    readonly #credentialKey = async (signal: AbortSignal): Promise<Uint8Array> => {
        signal.throwIfAborted();
        const result = await this.#storage.transaction(async (storage) => {
            // The stored name predates created identities; renaming it would change credentials a retry derives.
            const stored: unknown = await storage.get("replacement-key-v1");
            signal.throwIfAborted();
            if (stored !== undefined) {
                return v.parse(
                    v.pipe(
                        v.instance(Uint8Array),
                        v.check((key) => key.length === 32),
                    ),
                    stored,
                );
            }
            // Independent server entropy keeps a creation key or a retired predecessor token from deriving its
            // credential offline.
            // This key survives restarts, deployment credential rotation, and retries; no bearer token is stored.
            const key = crypto.getRandomValues(new Uint8Array(32));
            await storage.put("replacement-key-v1", key);
            return key;
        });
        signal.throwIfAborted();
        return result;
    };

    readonly #bindComputer = async (computerId: string): Promise<void> => {
        if (!this.#owns(computerId)) {
            throw new Error("Computer ID does not match this relay");
        }
        const stored: unknown = await this.#storage.get("computer-id");
        if (stored === undefined) {
            await this.#storage.put("computer-id", computerId);
            return;
        }
        if (stored !== computerId) {
            throw new Error("Durable Object computer identity does not match the request.");
        }
    };

    readonly #application = async (
        computerId: string,
        env: CloudBindings,
        signal: AbortSignal,
    ): Promise<ApplicationContext> => {
        const ownerUserId = await readComputerOwner(env, computerId, signal);
        return createApplicationDependencies({
            bindings: env,
            computer: this.#runtime(computerId),
            identity: { computerId, ownerUserId },
            identities: new IdentityStorage(this.#database(), computerId, ownerUserId),
            sessionOperations: this.#sessionOperations,
            identityOperations: { commitAccessEnd: this.#endAccess, credentialKey: this.#credentialKey },
        });
    };
}
