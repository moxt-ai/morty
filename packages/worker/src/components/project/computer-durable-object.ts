import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";
import application from "../../application.ts";
import type { CloudBindings } from "../../infra/cloud-bindings.ts";
import { DurableObjectDatabase } from "../../infra/durable-object-database.ts";
import { json } from "../../infra/http.ts";
import { cloudComputerId } from "../../middleware/computer-context.ts";
import { ManagedSessionOperations } from "../chat/infra/managed-session-operations.ts";
import { computerBootstrap } from "../management/entity/computer-bootstrap.ts";
import { platformIdentifier } from "../management/entity/platform-project.ts";

/**
 * One computer's storage. Only the computer's bootstrap binds the object and creates its schema; a request for an computer
 * the object does not hold leaves no storage behind.
 */
export class ComputerDurableObject extends DurableObject<CloudBindings> {
    #database: DurableObjectDatabase | undefined;
    readonly #sessionOperations = new ManagedSessionOperations();

    override async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        if (url.origin === "https://computer.internal" && url.pathname === "/__computer/bootstrap") {
            return await this.#bootstrap(request);
        }
        const computerId = await cloudComputerId(request);
        if (computerId === null) {
            return json({ error: { code: "PROJECT_REQUIRED", message: "Morty context is required." } }, 400);
        }
        const validatedComputerId = v.parse(platformIdentifier, computerId);
        const bound: unknown = await this.ctx.storage.get("project-id");
        if (bound === undefined) {
            return json({ error: { code: "PROJECT_NOT_FOUND", message: "The Morty computer does not exist." } }, 404);
        }
        if (bound !== validatedComputerId) {
            throw new Error("Durable Object computer identity does not match the request.");
        }
        return await application.fetch(request, this.#bindings(validatedComputerId));
    }

    readonly #bootstrap = async (request: Request): Promise<Response> => {
        const input: unknown = await request.json();
        const parsed = v.parse(computerBootstrap, input);
        await this.#bindComputer(parsed.computer.computerId);
        return await application.fetch(
            new Request(request.url, {
                body: JSON.stringify(parsed),
                headers: { "content-type": "application/json" },
                method: "POST",
                signal: request.signal,
            }),
            this.#bindings(parsed.computer.computerId),
        );
    };

    readonly #credentialKey = async (signal: AbortSignal): Promise<Uint8Array> => {
        signal.throwIfAborted();
        const result = await this.ctx.storage.transaction(async (storage) => {
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
        const stored: unknown = await this.ctx.storage.get("project-id");
        if (stored === undefined) {
            await this.ctx.storage.put("project-id", computerId);
            return;
        }
        if (stored !== computerId) {
            throw new Error("Durable Object computer identity does not match the request.");
        }
    };

    readonly #bindings = (computerId: string): CloudBindings => {
        this.#database ??= new DurableObjectDatabase(this.ctx.storage);
        return {
            ...this.env,
            CHAT_COMPUTER_ID: computerId,
            CHAT_SESSION_OPERATIONS: this.#sessionOperations,
            CHAT_CREDENTIAL_KEY: this.#credentialKey,
            DATABASE: this.#database,
        };
    };
}
