import {
    decodeDaemonToServiceMessage,
    decodeServiceToDaemonMessage,
    type SessionClosedEvent,
    type SessionOperationFailedEvent,
} from "@morty-build/client/protocol";
import * as v from "valibot";
import { SqliteComputerRelayStore } from "../../src/computer-relay/components/management/storage/sqlite-computer-relay-store.ts";
import { ComputerRelay as ProductionComputerRelay } from "../../src/computer-relay/computer-relay.ts";
import { DurableObjectDatabase } from "../../src/computer-relay/infra/durable-object-database.ts";
import { ProjectRowSchema } from "../../src/contracts/relay/relay-records.ts";
import type { ConfiguredRelayBindings } from "../../src/contracts/relay-bindings.ts";
import { RequestDeadline } from "../../src/http/request-deadline.ts";
import chat from "../../src/index.ts";

// The public Worker reaches the production ComputerRelay namespace.
export default {
    fetch: async (request: Request, env: ConfiguredRelayBindings) => {
        const target = new URL(request.url).pathname.match(
            /^\/__test\/computers\/([^/]+)\/harnesses\/([^/]+)\/sessions\/([^/]+)\/close$/u,
        );
        if (
            request.method === "POST" &&
            target?.[1] !== undefined &&
            target[2] !== undefined &&
            target[3] !== undefined
        ) {
            return await env.COMPUTER_RELAY.getByName(target[1]).fetch(
                new Request("https://computer.internal/close-session", {
                    method: "POST",
                    signal: request.signal,
                    body: JSON.stringify({
                        kind: "session.close",
                        requestId: crypto.randomUUID(),
                        target: { harness: decodeURIComponent(target[2]), sessionId: decodeURIComponent(target[3]) },
                    }),
                }),
            );
        }
        return await chat.fetch(request, env);
    },
};

/** Seeds persisted boundary conditions while keeping authentication and revocation on the production HTTP path. */
export class ComputerRelay extends ProductionComputerRelay {
    readonly #closing = new Map<string, (result: SessionClosedEvent | SessionOperationFailedEvent) => void>();

    override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
        await super.webSocketMessage(socket, message);
        if (typeof message !== "string" || this.#closing.size === 0) {
            return;
        }
        try {
            const result = decodeDaemonToServiceMessage(message);
            if (result.kind === "session.closed" || result.kind === "session.operation.failed") {
                this.#closing.get(result.requestId)?.(result);
            }
        } catch {
            // Unrelated frames remain owned by the production callback.
        }
    }

    override async fetch(request: Request): Promise<Response> {
        if (request.url === "https://computer.internal/retire-account" && request.method === "POST") {
            const value: unknown = await request.json();
            const input = v.parse(v.object({ computerId: v.string() }), value);
            const stored: unknown = await this.ctx.storage.get("computer-account");
            const account = v.parse(ProjectRowSchema, stored);
            if (account.computer_id !== input.computerId) {
                throw new Error("The test account does not match its Computer.");
            }
            await this.ctx.storage.put("computer-account", { ...account, lifecycle: "deleted" });
            return new Response(null, { status: 204 });
        }
        if (request.url === "https://computer.internal/close-session" && request.method === "POST") {
            // Set a real daemon lifecycle condition through its protocol; the browser still observes production events.
            const command = decodeServiceToDaemonMessage(await request.text());
            if (command.kind !== "session.close") {
                return new Response("Expected a Session close command", { status: 400 });
            }
            const daemon = this.ctx.getWebSockets("daemon").find((socket) => socket.readyState === WebSocket.OPEN);
            if (daemon === undefined) {
                return new Response("Computer offline", { status: 503 });
            }
            using deadline = new RequestDeadline(request.signal, 30_000);
            const reply = Promise.withResolvers<SessionClosedEvent | SessionOperationFailedEvent>();
            this.#closing.set(command.requestId, reply.resolve);
            try {
                daemon.send(JSON.stringify(command));
                const result = await deadline.wait(reply.promise);
                return Response.json(result, { status: result.kind === "session.closed" ? 200 : 409 });
            } finally {
                this.#closing.delete(command.requestId);
            }
        }

        if (request.url === "https://computer.internal/revoked-computer" && request.method === "POST") {
            const computerId = await request.text();
            await new SqliteComputerRelayStore(computerId, new DurableObjectDatabase(this.ctx.storage)).revokeComputer(
                {
                    computerId,
                    now: Date.now(),
                    actorKind: "system",
                    actorId: computerId,
                    auditId: `test-revocation-${crypto.randomUUID()}`,
                },
                request.signal,
            );
            return new Response(null, { status: 204 });
        }
        if (request.url === "https://computer.internal/aged-links" && request.method === "POST") {
            // Reconstruct links whose device term has passed: the Durable Object's clock cannot be moved forward.
            this.ctx.storage.sql.exec(
                "UPDATE identity_transfer SET created_at = created_at - (access_expires_at - created_at), expires_at = expires_at - (access_expires_at - created_at), access_expires_at = created_at",
            );
            return new Response(null, { status: 204 });
        }
        if (request.url === "https://computer.internal/stored-state") {
            // Read-only: reports what this object persisted, without opening its database.
            return Response.json({
                keys: [...(await this.ctx.storage.list()).keys()],
                tables: this.ctx.storage.sql
                    .exec<{ name: string }>(
                        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
                    )
                    .toArray()
                    .map((row) => row.name),
            });
        }
        if (request.url === "https://computer.internal/credential-kinds") {
            return Response.json(
                this.ctx.storage.sql
                    .exec<{ kind: string }>(
                        "SELECT kind FROM owner_credential UNION ALL SELECT 'browser' FROM browser_credential",
                    )
                    .toArray()
                    .map((row) => row.kind),
            );
        }
        return await super.fetch(request);
    }
}
