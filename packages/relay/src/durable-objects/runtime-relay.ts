import { DurableObject } from "cloudflare:workers";
import {
    MORTY_API_PREFIX,
    RUNTIME_HEARTBEAT_ACK_MESSAGE,
    RUNTIME_HEARTBEAT_MESSAGE,
} from "@morty-build/client/protocol";
import {
    acceptWebSocketHttpTransport,
    createLocalSessionOperations,
    DurableObjectSqlDatabase,
    logger,
    RuntimeRelay as RuntimeRelayImplementation,
    standardWebSocketHost,
    WebSocketUploadBudget,
} from "@morty-build/relay-core";
import { SessionAccessSigner } from "../entity/session-access-credential.ts";
import { runtimeRequestTarget } from "../gateway/runtime-session-routing.ts";
import { authorizeSessionContentUpload } from "../http/session-content-upload.ts";
import {
    type ConfiguredPlatformRelayBindings,
    createPlatformAccessServices,
    createPlatformWorker,
} from "../platform-worker.ts";
import { createPlatformDurableObjectContext } from "./platform-durable-object-context.ts";

// How long a host connection or a live Session view may keep receiving after its credential stops authorizing it.
const REAUTHORIZATION_INTERVAL_MILLISECONDS = 60_000;

export class RuntimeRelay extends DurableObject<ConfiguredPlatformRelayBindings> {
    readonly #uploads = new WebSocketUploadBudget();
    readonly #runtime: RuntimeRelayImplementation;
    readonly #context: ReturnType<typeof createPlatformDurableObjectContext>;
    readonly #environment: ConfiguredPlatformRelayBindings;
    readonly #application = createPlatformWorker();
    readonly #state: DurableObjectState;

    constructor(state: DurableObjectState, environment: ConfiguredPlatformRelayBindings) {
        super(state, environment);
        this.#environment = environment;
        this.#state = state;
        // Cloudflare answers daemon heartbeats itself, so an idle Runtime connection never wakes this object.
        state.setWebSocketAutoResponse(
            new WebSocketRequestResponsePair(RUNTIME_HEARTBEAT_MESSAGE, RUNTIME_HEARTBEAT_ACK_MESSAGE),
        );
        this.#context = createPlatformDurableObjectContext(state, environment, {
            database: new DurableObjectSqlDatabase(state.storage),
        });
        this.#runtime = new RuntimeRelayImplementation(
            this.#context,
            logger.child({
                durableObjectClass: "RuntimeRelay",
                durableObjectId: state.id.toString(),
                runtimeInstanceId: crypto.randomUUID(),
                runtimeInstanceStartedAt: Date.now(),
            }),
        );
    }

    override async fetch(request: Request): Promise<Response> {
        const current = runtimeRequestTarget(request);
        if (current !== null) {
            const environment = {
                ...this.#environment,
                MORTY_RUNTIME_EXECUTION: {
                    accountId: current.accountId,
                    runtimeId: current.runtimeId,
                    operations: createLocalSessionOperations(this.#context, current.accountId, current.runtimeId),
                },
            };
            if (
                new URL(request.url).pathname ===
                `${MORTY_API_PREFIX}/v1/accounts/${current.accountId}/runtimes/${current.runtimeId}/transport`
            ) {
                return acceptWebSocketHttpTransport(
                    request,
                    async (operation) => {
                        const response = await this.#application.fetch(operation, environment);
                        if (response.status === 101) {
                            await this.scheduleConnectionChecks();
                        }
                        return response;
                    },
                    standardWebSocketHost,
                    {
                        uploads: this.#uploads,
                        authorizeUpload: async (operation) => {
                            const { sessionAccess } = createPlatformAccessServices(environment);
                            const authorized = await authorizeSessionContentUpload(operation, sessionAccess);
                            return authorized instanceof Response ? authorized : new Response(null, { status: 204 });
                        },
                        validateTarget: (operation) => {
                            const target = runtimeRequestTarget(operation);
                            return (
                                target !== null &&
                                target.accountId === current.accountId &&
                                target.runtimeId === current.runtimeId &&
                                !new URL(operation.url).pathname.endsWith("/transport")
                            );
                        },
                    },
                );
            }
            const response = await this.#application.fetch(request, environment);
            if (response.status === 101) {
                await this.scheduleConnectionChecks();
            }
            return response;
        }
        const response = await this.#runtime.fetch(request);
        if (response.status === 101) {
            await this.scheduleConnectionChecks();
        }
        return response;
    }

    /**
     * Sets the alarm for the earliest open connection check: a viewer's expiry, or the next re-authorization of the
     * hosts and viewers. A pending check that is earlier is kept, so new connections never postpone it.
     */
    private readonly scheduleConnectionChecks = async (): Promise<void> => {
        const viewers = this.#context.gateways.peers.viewers().filter(({ socket }) => socket.isOpen());
        const checks = viewers.map(({ expiresAt }) => expiresAt);
        if (viewers.length > 0 || this.#context.gateways.peers.hosts().some((host) => host.isOpen())) {
            checks.push(Date.now() + REAUTHORIZATION_INTERVAL_MILLISECONDS);
        }
        if (checks.length === 0) {
            await this.#state.storage.deleteAlarm();
            return;
        }
        // An alarm that is already due (the one running now) is not a pending check.
        const scheduled = await this.#state.storage.getAlarm();
        const pending = scheduled !== null && scheduled > Date.now() ? scheduled : Number.POSITIVE_INFINITY;
        await this.#state.storage.setAlarm(Math.min(...checks, pending));
    };

    override async alarm(): Promise<void> {
        const signingKeyId = await new SessionAccessSigner(this.#environment.MORTY_SESSION_SIGNING_SECRET).keyId();
        for (const { socket, identity } of this.#context.gateways.peers.sockets()) {
            if (identity.role !== "viewer") {
                continue;
            }
            if (identity.credential?.signingKeyId !== signingKeyId) {
                socket.close(1008, "Session signing key rotated");
            } else if (identity.expiresAt <= Date.now()) {
                socket.close(1000, "Session access expired");
            }
        }
        try {
            await this.#runtime.reauthorizeConnections();
        } finally {
            await this.scheduleConnectionChecks();
        }
    }

    override async webSocketMessage(socket: WebSocket, message: unknown): Promise<void> {
        await this.#runtime.webSocketMessage(socket, message);
    }

    override async webSocketClose(socket: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
        await this.#runtime.webSocketClose(socket, { code, reason, wasClean });
    }

    override webSocketError(socket: WebSocket, error: unknown): void {
        this.#runtime.webSocketError(socket, error);
    }
}
