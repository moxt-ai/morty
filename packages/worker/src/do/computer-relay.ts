import { DurableObject } from "cloudflare:workers";
import {
    RUNTIME_HEARTBEAT_ACK_MESSAGE,
    RUNTIME_HEARTBEAT_MESSAGE,
    type SessionAccessHolder,
} from "@morty-build/client/protocol";
import { computerRequestTarget } from "@morty-build/client/relay";
import {
    acceptWebSocketHttpTransport,
    type ClaimPairing,
    createLocalSessionOperations,
    DurableObjectDatabaseAdapter,
    DurableObjectSqlDatabase,
    RelaySockets,
    type RequestRuntimePairing,
    type RevokeRuntime,
    type RuntimePairingRequest,
    standardWebSocketHost,
    WebSocketUploadBudget,
} from "@morty-build/relay";
import { logger } from "@morty-build/relay/logging";
import { decodeComputerDurableObjectPath } from "../../../relay/src/components/computer/entity/computer-durable-object-path.ts";
import { decodeComputerPlacement } from "../../../relay/src/components/computer/entity/computer-id.ts";
import { migrateComputerStorage } from "../../../relay/src/components/computer/migrate-computer-storage.ts";
import { ComputerBackendService } from "../../../relay/src/components/computer/service/computer-backend-service.ts";
import type {
    ProjectAuditRow,
    RelayAuditRecord,
} from "../../../relay/src/components/management/entity/relay-records.ts";
import type { ComputerManagementStore } from "../../../relay/src/components/management/storage/computer-management-store.ts";
import { SqliteComputerManagementStore } from "../../../relay/src/components/management/storage/sqlite-computer-management-store.ts";
import { SessionAccessSigner } from "../../../relay/src/components/runtime/entity/session-access-credential.ts";
import { authorizeSessionContentUpload } from "../../../relay/src/components/runtime/http/session-content-upload.ts";
import { RuntimeOperationsService } from "../../../relay/src/components/runtime/service/runtime-operations-service.ts";
import { ComputerChat } from "../components/project/computer-chat.ts";
import type { ConfiguredRelayBindings } from "../composition/relay-bindings.ts";
import { createRelayDurableObjectContext } from "../composition/relay-durable-object-context.ts";
import { createComputerRelayRoutes } from "../composition/relay-http.ts";
import {
    type ComputerExecution,
    composeRelayContext,
    createHostedRelayAccess,
    createRelayPorts,
} from "../composition/relay-services.ts";
import { cloudComputerId } from "../middleware/computer-context.ts";

const REAUTHORIZATION_INTERVAL_MILLISECONDS = 60_000;

type Store = ComputerManagementStore;
type Result<Operation extends keyof Store> = Awaited<ReturnType<Store[Operation]>>;

// Operations run to completion once delivered; a caller that gives up only stops waiting for the result.
const uncancelled = new AbortController().signal;

/**
 * Owns one computer's storage. Requests routed to the computer run here against that storage, and every other
 * Worker or Durable Object reaches it only through the typed operations below, each executed here as one unit.
 */
export class ComputerRelay extends DurableObject<ConfiguredRelayBindings> {
    readonly #routes = createComputerRelayRoutes();
    #store: Store | null = null;

    readonly #chat = new ComputerChat(
        this.ctx.storage,
        (id) => this.#owns(id),
        (change) => this.#endAccess(change),
        (computerId) => this.#backendServices(computerId),
    );

    readonly #uploads = new WebSocketUploadBudget();
    #connections: ReturnType<ComputerRelay["createConnections"]> | undefined;

    constructor(state: DurableObjectState, environment: ConfiguredRelayBindings) {
        super(state, environment);
        state.setWebSocketAutoResponse(
            new WebSocketRequestResponsePair(RUNTIME_HEARTBEAT_MESSAGE, RUNTIME_HEARTBEAT_ACK_MESSAGE),
        );
    }

    private createConnections() {
        migrateComputerStorage(this.ctx.storage);
        const context = createRelayDurableObjectContext(this.ctx, this.env, {
            database: new DurableObjectSqlDatabase(this.ctx.storage),
            storeFor: (computerId) => this.#operate(computerId),
        });
        return {
            context,
            sockets: new RelaySockets(
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
        this.#connections ??= this.createConnections();
        return this.#connections;
    }

    /** The store of the computer this object holds; null when `computerId` names another computer. */
    #computerStore(computerId: string): Store | null {
        if (!this.#owns(computerId)) {
            return null;
        }
        if (this.#store === null) {
            migrateComputerStorage(this.ctx.storage);
            this.#store = new SqliteComputerManagementStore(
                computerId,
                new DurableObjectDatabaseAdapter(this.ctx.storage),
                (holder, signal) => this.#chat.holdsAccess(computerId, holder, this.env, signal),
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

    readonly #localRelay = (computerId: string, request: Request): Promise<Response> => {
        if (!this.#owns(computerId)) {
            throw new Error("Computer ID does not match this relay");
        }
        return this.fetch(request);
    };

    async #fetchComputer(request: Request): Promise<Response> {
        const requestUrl = new URL(request.url);
        const computerPath = decodeComputerDurableObjectPath(requestUrl.pathname);
        try {
            const placement = computerPath === null ? null : decodeComputerPlacement(computerPath.computerId);
            if (computerPath === null || placement === null) {
                return Response.json(
                    { error: { code: "computer_id_invalid", message: "The Computer identifier is invalid" } },
                    { status: 400 },
                );
            }
            const computerId = computerPath.computerId;
            const store = this.#computerStore(computerId);
            if (store === null) {
                return Response.json(
                    { error: { code: "computer_id_mismatch", message: "The computer is unavailable" } },
                    { status: 421 },
                );
            }
            requestUrl.pathname = computerPath.requestPathname;
            const routedRequest = new Request(requestUrl, request);
            return await this.#routes.fetch(routedRequest, {
                ...this.env,
                execution: this.#execution(computerId, store),
            });
        } catch (error) {
            request.signal.throwIfAborted();
            logger.error(
                {
                    event: "project_do_request_failed",
                    durableObjectClass: "ComputerRelay",
                    durableObjectId: this.ctx.id.toString(),
                    computerId: computerPath?.computerId ?? null,
                    method: request.method,
                    path: computerPath?.requestPathname ?? requestUrl.pathname,
                    cfRay: request.headers.get("cf-ray")?.slice(0, 128) ?? null,
                    err: error,
                },
                "Account Durable Object request failed",
            );
            throw error;
        }
    }

    async updateAgentCatalog(computerId: string, tokenHash: string, agents: string): Promise<boolean> {
        return await this.#operate(computerId).updateAgentCatalog(computerId, tokenHash, agents, uncancelled);
    }

    async readActiveGeneration(computerId: string): Promise<number | null> {
        return await this.#operate(computerId).readActiveGeneration(computerId, uncancelled);
    }

    async readRuntime(computerId: string): Promise<Result<"readRuntime">> {
        return await this.#operate(computerId).readRuntime(computerId, uncancelled);
    }

    async listRuntimes(computerId: string): Promise<Result<"listRuntimes">> {
        return await this.#operate(computerId).listRuntimes(uncancelled);
    }

    async requestRuntimePairing(computerId: string, value: RequestRuntimePairing): Promise<RuntimePairingRequest> {
        return await this.#operate(computerId).requestRuntimePairing(value, uncancelled);
    }

    async readRuntimePairing(computerId: string): Promise<Result<"readRuntimePairing">> {
        return await this.#operate(computerId).readRuntimePairing(computerId, uncancelled);
    }

    async readPairingCode(computerId: string, codeHash: string): Promise<Result<"readPairingCode">> {
        return await this.#operate(computerId).readPairingCode(codeHash, uncancelled);
    }

    async claimPairing(computerId: string, value: ClaimPairing): Promise<boolean> {
        return await this.#operate(computerId).claimPairing(value, uncancelled);
    }

    async revokeRuntime(computerId: string, value: RevokeRuntime): Promise<Result<"revokeRuntime">> {
        return await this.#operate(computerId).revokeRuntime(value, uncancelled);
    }

    async findCredential(
        computerId: string,
        credential: Parameters<Store["findCredential"]>[0],
    ): Promise<Result<"findCredential">> {
        return await this.#operate(computerId).findCredential(credential, uncancelled);
    }

    async rotateRuntimeCredential(
        computerId: string,
        presentedHash: string,
        successorHash: string,
    ): Promise<Result<"rotateRuntimeCredential">> {
        return await this.#operate(computerId).rotateRuntimeCredential(presentedHash, successorHash, uncancelled);
    }

    async holdsAccess(computerId: string, holder: SessionAccessHolder): Promise<boolean> {
        return await this.#operate(computerId).holdsAccess(holder, uncancelled);
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

    async recordAudit(computerId: string, audit: RelayAuditRecord): Promise<void> {
        await this.#operate(computerId).recordAudit(audit, uncancelled);
    }

    async listAuditEvents(computerId: string, limit: number): Promise<readonly ProjectAuditRow[]> {
        return await this.#operate(computerId).listAuditEvents(limit, uncancelled);
    }
    override async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        if (url.origin === "https://computer.internal" || (await cloudComputerId(request)) !== null) {
            return this.#chat.fetch(request, this.env);
        }
        if (decodeComputerDurableObjectPath(url.pathname) !== null) {
            return this.#fetchComputer(request);
        }
        const current = computerRequestTarget(request);
        if (current !== null) {
            if (!this.#owns(current.computerId)) {
                return Response.json({ error: { code: "runtime_access_denied" } }, { status: 403 });
            }
            if (current.kind === "transport") {
                return acceptWebSocketHttpTransport(
                    request,
                    (operation) => this.fetch(operation),
                    standardWebSocketHost,
                    {
                        uploads: this.#uploads,
                        authorizeUpload: async (operation) => {
                            const { sessionAccess } = createHostedRelayAccess(this.env);
                            const authorized = await authorizeSessionContentUpload(operation, sessionAccess);
                            return authorized instanceof Response ? authorized : new Response(null, { status: 204 });
                        },
                        validateTarget: (operation) => {
                            const target = computerRequestTarget(operation);
                            return target?.kind === "operation" && target.computerId === current.computerId;
                        },
                    },
                );
            }
            const response = await this.#routes.fetch(request, {
                ...this.env,
                execution: this.#execution(current.computerId, this.#operate(current.computerId)),
            });
            if (response.status === 101) {
                await this.scheduleConnectionChecks();
            }
            return response;
        }
        const response = await this.#connectionsForComputer.sockets.fetch(request);
        if (response.status === 101) {
            await this.scheduleConnectionChecks();
        }
        return response;
    }

    #execution(computerId: string, store: ComputerManagementStore): ComputerExecution {
        return {
            computerId,
            store,
            relay: this.#localRelay,
            operations: createLocalSessionOperations(this.#connectionsForComputer.context, computerId),
        };
    }

    #backendServices(computerId: string): ComputerBackendService {
        const execution = this.#execution(computerId, this.#operate(computerId));
        const access = createHostedRelayAccess(this.env, execution);
        const context = composeRelayContext(access, createRelayPorts(this.env, execution));
        return new ComputerBackendService(
            computerId,
            context,
            access.sessionAccess,
            this.env.MORTY_SESSION_SIGNING_SECRET,
            new RuntimeOperationsService(context.services.pairings, execution.operations),
        );
    }

    /**
     * Sets the alarm for the earliest open connection check: a viewer's expiry, or the next re-authorization of the
     * hosts and viewers. A pending check that is earlier is kept, so new connections never postpone it.
     */
    private readonly scheduleConnectionChecks = async (): Promise<void> => {
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
            await this.#connectionsForComputer.sockets.reauthorizeConnections();
        } finally {
            await this.scheduleConnectionChecks();
        }
    }

    override async webSocketMessage(socket: WebSocket, message: unknown): Promise<void> {
        await this.#connectionsForComputer.sockets.webSocketMessage(socket, message);
    }

    override async webSocketClose(socket: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
        await this.#connectionsForComputer.sockets.webSocketClose(socket, { code, reason, wasClean });
    }

    override webSocketError(socket: WebSocket, error: unknown): void {
        this.#connectionsForComputer.sockets.webSocketError(socket, error);
    }
}
