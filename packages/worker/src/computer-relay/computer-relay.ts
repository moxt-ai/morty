import { DurableObject } from "cloudflare:workers";
import { COMPUTER_HEARTBEAT_ACK_MESSAGE, COMPUTER_HEARTBEAT_MESSAGE } from "@morty-build/client/protocol";
import { Hono, type MiddlewareHandler } from "hono";
import { decodeComputerPlacement } from "../contracts/computer-id.ts";
import { ComputerManagementError } from "../contracts/computer-management.ts";
import { COMPUTER_INTERNAL_PREFIX } from "../contracts/computer-relay-http.ts";
import { relayAuthenticationFromEnvironment } from "../contracts/relay-authentication-environment.ts";
import type { ConfiguredRelayBindings } from "../contracts/relay-bindings.ts";
import {
    type ComputerTargetEnvironment,
    computerFromPath,
    computerFromRuntimeCredential,
} from "../http/computer-target.ts";
import { logger } from "../infra/logger.ts";
import { errorMiddleware, relayErrorHandler } from "../middleware/error-middleware.ts";
import { requestTimeoutMiddleware } from "../middleware/request-timeout-middleware.ts";
import { ComputerBackendService } from "./components/computer/service/computer-backend-service.ts";
import { ComputerInternalService } from "./components/management/service/computer-internal-service.ts";
import type { ComputerManagementStore } from "./components/management/storage/computer-management-store.ts";
import { DurableComputerAccount } from "./components/management/storage/durable-computer-account.ts";
import { SqliteComputerManagementStore } from "./components/management/storage/sqlite-computer-management-store.ts";
import { DaemonWebSocketRoutes } from "./components/runtime/daemon-websocket-routes.ts";
import { SessionAccessSigner } from "./components/runtime/entity/session-access-credential.ts";
import { WebSocketUploadBudget } from "./components/runtime/http/websocket-http-transport.ts";
import { createLocalSessionOperations } from "./components/runtime/service/local-session-operations.ts";
import type { ComputerRouteContext } from "./composition/computer-route-context.ts";
import { ComputerServices } from "./composition/computer-services.ts";
import { createRelayDurableObjectContext } from "./composition/relay-durable-object-context.ts";
import { createComputerRelayServices } from "./composition/relay-services.ts";
import type { ComputerRouteHttpEnvironment } from "./http/environment.ts";
import { createComputerHttpRoutes } from "./http/routes.ts";
import { DurableObjectDatabase } from "./infra/durable-object-database.ts";

const REAUTHORIZATION_INTERVAL_MILLISECONDS = 60_000;

type Store = ComputerManagementStore;
type ComputerHttpEnvironment = ComputerRouteHttpEnvironment &
    ComputerTargetEnvironment & {
        readonly Bindings: ConfiguredRelayBindings;
    };

/**
 * Owns one computer's storage. Requests routed to the computer run here against that storage, and every other
 * Worker or Durable Object reaches it only through its HTTP boundary.
 */
export class ComputerRelay extends DurableObject<ConfiguredRelayBindings> {
    #store: Store | null = null;
    readonly #account = new DurableComputerAccount(this.ctx.storage);

    readonly #browserServices = new ComputerServices(
        this.ctx.storage,
        (id) => this.#owns(id),
        (change) => this.#endAccess(change),
        (computerId) => this.#backendServices(computerId),
        () => this.#computerDatabase,
        (computerId, signal) => this.#account.readActiveComputerScope(computerId, signal),
    );

    readonly #uploads = new WebSocketUploadBudget();
    readonly #http = this.#createHttpRoutes();

    #createHttpRoutes() {
        const computer = this;
        const ctx: ComputerRouteContext = {
            bindings: this.env,
            services: {
                browser: this.#browserServices,
                get runtime() {
                    return computer.#connectionsForComputer.context.services.runtime;
                },
            },
            resources: { uploads: this.#uploads },
            utilities: {
                connectionOpened: () => this.#scheduleConnectionChecks(),
            },
        };
        const initialize: MiddlewareHandler<ComputerHttpEnvironment> = async (context, next) => {
            const computerId = context.var.computerId;
            const store = this.#computerStore(computerId);
            if (store === null) {
                throw new ComputerManagementError("computer_id_mismatch", "The computer is unavailable", 421);
            }
            const { access, relay } = this.#services(computerId, store);
            context.set("allowedOrigins", relayAuthenticationFromEnvironment(context.env).allowedOrigins);
            context.set("sessionAccess", access.sessionAccess);
            context.set("relay", relay);
            context.set(
                "sessionOperations",
                createLocalSessionOperations(this.#connectionsForComputer.context, computerId),
            );
            await next();
            return;
        };
        const initializeInternal: MiddlewareHandler<ComputerHttpEnvironment> = async (context, next) => {
            const computerId = context.var.computerId;
            const store = this.#computerStore(computerId);
            if (store === null) {
                throw new ComputerManagementError("computer_id_mismatch", "The computer is unavailable", 421);
            }
            context.set("computerInternal", new ComputerInternalService(computerId, store, this.#account));
            await next();
        };
        return new Hono<ComputerHttpEnvironment>()
            .onError(relayErrorHandler)
            .use(
                `${COMPUTER_INTERNAL_PREFIX}/:computerId/*`,
                errorMiddleware,
                requestTimeoutMiddleware<ComputerHttpEnvironment>(30_000),
                computerFromPath,
                initializeInternal,
            )
            .use("/morty/api/*", errorMiddleware, requestTimeoutMiddleware<ComputerHttpEnvironment>(30_000))
            .use("/morty/api/v1/pairings/:computerId/redeem", computerFromPath, initialize)
            .use("/morty/api/channels/:computerId/catalog", computerFromPath, initialize)
            .use("/morty/api/v1/computers/connect", computerFromRuntimeCredential, initialize)
            .use("/morty/api/v1/computers/:computerId/transport", computerFromPath, initialize)
            .use(
                "/morty/api/v1/computers/:computerId/harnesses/:harness/sessions/:sessionId/files/content",
                computerFromPath,
                initialize,
            )
            .route("/", createComputerHttpRoutes(ctx))
            .notFound(() =>
                Response.json(
                    { error: { code: "not_found", message: "The requested Morty resource does not exist" } },
                    { status: 404 },
                ),
            );
    }
    #connections:
        | {
              readonly context: ReturnType<typeof createRelayDurableObjectContext>;
              readonly daemonWebSocket: DaemonWebSocketRoutes;
          }
        | undefined;

    constructor(state: DurableObjectState, environment: ConfiguredRelayBindings) {
        super(state, environment);
        state.setWebSocketAutoResponse(
            new WebSocketRequestResponsePair(COMPUTER_HEARTBEAT_MESSAGE, COMPUTER_HEARTBEAT_ACK_MESSAGE),
        );
    }

    #createConnections() {
        const context = createRelayDurableObjectContext(this.ctx, {
            database: this.#computerDatabase,
            accounts: this.#account,
            storeFor: (computerId) => this.#operate(computerId),
        });
        return {
            context,
            daemonWebSocket: new DaemonWebSocketRoutes(
                context,
                logger.child({
                    durableObjectClass: "ComputerRelay",
                    durableObjectId: this.ctx.id.toString(),
                    runtimeInstanceId: crypto.randomUUID(),
                    runtimeInstanceStartedAt: Date.now(),
                }),
            ),
        };
    }

    get #connectionsForComputer() {
        this.#connections ??= this.#createConnections();
        return this.#connections;
    }

    #database: DurableObjectDatabase | undefined;
    get #computerDatabase(): DurableObjectDatabase {
        this.#database ??= new DurableObjectDatabase(this.ctx.storage);
        return this.#database;
    }

    /** The store of the computer this object holds; null when `computerId` names another computer. */
    #computerStore(computerId: string): Store | null {
        if (!this.#owns(computerId)) {
            return null;
        }
        if (this.#store === null) {
            this.#store = new SqliteComputerManagementStore(computerId, this.#computerDatabase, (holder, signal) =>
                this.#browserServices.holdsAccess(computerId, holder, signal),
            );
        }
        return this.#store;
    }

    #owns(computerId: string): boolean {
        return this.env.COMPUTER_RELAY.idFromName(computerId).toString() === this.ctx.id.toString();
    }

    #operate(computerId: string): Store {
        const store = decodeComputerPlacement(computerId) === null ? null : this.#computerStore(computerId);
        if (store === null) {
            throw new Error("The computer is unavailable");
        }
        return store;
    }

    /**
     * Commits an identity change that may end access to the computer, and with it the connection check that closes the
     * live views and host connections the change no longer authorizes. Requests read the identities, so the committed
     * change is already in force; the check only ends the open connections, and the alarm retries it until it runs.
     */
    readonly #endAccess = async (change: () => Promise<boolean>): Promise<boolean> =>
        await this.ctx.storage.transaction(async (transaction) => {
            if (!(await change())) {
                return false;
            }
            await transaction.setAlarm(Date.now());
            return true;
        });

    override async fetch(request: Request): Promise<Response> {
        const response = await this.#http.fetch(request, this.env);
        if (response.status === 101) {
            await this.#scheduleConnectionChecks();
        }
        return response;
    }

    #servicesCache: ReturnType<typeof createComputerRelayServices> | undefined;
    #services(computerId: string, store: ComputerManagementStore) {
        this.#servicesCache ??= createComputerRelayServices(
            this.env,
            computerId,
            store,
            this.#connectionsForComputer.context.services.runtime,
            this.#account,
        );
        return this.#servicesCache;
    }

    #backendServices(computerId: string): ComputerBackendService {
        const { access, relay } = this.#services(computerId, this.#operate(computerId));
        return new ComputerBackendService(
            computerId,
            relay,
            access.sessionAccess,
            this.env.MORTY_SESSION_SIGNING_SECRET,
            createLocalSessionOperations(this.#connectionsForComputer.context, computerId),
        );
    }

    /**
     * Sets the alarm for the earliest open connection check: a viewer's expiry, or the next re-authorization of the
     * hosts and viewers. A pending check that is earlier is kept, so new connections never postpone it.
     */
    readonly #scheduleConnectionChecks = async (): Promise<void> => {
        const viewers = this.#connectionsForComputer.context.gateways.peers
            .viewers()
            .filter(({ socket }) => socket.isOpen());
        const checks = viewers.map(({ expiresAt }) => expiresAt);
        if (
            viewers.length > 0 ||
            this.#connectionsForComputer.context.gateways.peers.hosts().some((host) => host.isOpen())
        ) {
            checks.push(Date.now() + REAUTHORIZATION_INTERVAL_MILLISECONDS);
        }
        if (checks.length === 0) {
            await this.ctx.storage.deleteAlarm();
            return;
        }
        // An alarm that is already due (the one running now) is not a pending check.
        const scheduled = await this.ctx.storage.getAlarm();
        const pending = scheduled !== null && scheduled > Date.now() ? scheduled : Number.POSITIVE_INFINITY;
        await this.ctx.storage.setAlarm(Math.min(...checks, pending));
    };

    override async alarm(): Promise<void> {
        const signingKeyId = await new SessionAccessSigner(this.env.MORTY_SESSION_SIGNING_SECRET).keyId();
        for (const { socket, identity } of this.#connectionsForComputer.context.gateways.peers.sockets()) {
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
            await this.#connectionsForComputer.daemonWebSocket.reauthorizeConnections();
        } finally {
            await this.#scheduleConnectionChecks();
        }
    }

    override async webSocketMessage(socket: WebSocket, message: unknown): Promise<void> {
        await this.#connectionsForComputer.daemonWebSocket.webSocketMessage(socket, message);
    }

    override async webSocketClose(socket: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
        await this.#connectionsForComputer.daemonWebSocket.webSocketClose(socket, { code, reason, wasClean });
    }

    override webSocketError(socket: WebSocket, error: unknown): void {
        this.#connectionsForComputer.daemonWebSocket.webSocketError(socket, error);
    }
}
