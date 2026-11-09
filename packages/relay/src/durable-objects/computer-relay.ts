import { DurableObject } from "cloudflare:workers";
import { RUNTIME_HEARTBEAT_ACK_MESSAGE, RUNTIME_HEARTBEAT_MESSAGE } from "@morty-build/client/protocol";
import {
    type AccessGrantRedemption,
    acceptWebSocketHttpTransport,
    type ClaimPairing,
    type CreateAccessGrant,
    type CreateBrowserCredential,
    createLocalSessionOperations,
    DurableObjectDatabaseAdapter,
    DurableObjectSqlDatabase,
    type RedeemAccessGrant,
    RelaySockets,
    type RequestRuntimePairing,
    type RevokeRuntime,
    type RuntimePairingRequest,
    runtimeConnectionDurableObjectMigrations,
    standardWebSocketHost,
    WebSocketUploadBudget,
} from "@morty-build/relay-core";
import { applyDurableObjectMigrations } from "@morty-build/relay-core/durable-object-migrations";
import { logger } from "@morty-build/relay-core/logging";
import { ComputerChat } from "../../../worker/src/components/project/computer-chat.ts";
import { cloudComputerId } from "../../../worker/src/middleware/computer-context.ts";
import { decodeComputerDurableObjectPath } from "../entity/computer-durable-object-path.ts";
import { decodeComputerPlacement } from "../entity/computer-id.ts";
import type { PlatformAuditRecord, ProjectAuditRow } from "../entity/platform-records.ts";
import { SessionAccessSigner } from "../entity/session-access-credential.ts";
import { computerRequestTarget } from "../gateway/runtime-session-routing.ts";
import { computerDurableObjectMigrations } from "../generated/project-do-migrations.ts";
import { authorizeSessionContentUpload } from "../http/session-content-upload.ts";
import type { PlatformProjectStore } from "../infra/platform-project-store.ts";
import {
    type ComputerPlatformRelayBindings,
    type ConfiguredPlatformRelayBindings,
    createPlatformAccessServices,
    createPlatformWorker,
} from "../platform-worker.ts";
import { SqlitePlatformProjectStore } from "../storage/sqlite-platform-project-store.ts";
import { createPlatformDurableObjectContext } from "./platform-durable-object-context.ts";

const REAUTHORIZATION_INTERVAL_MILLISECONDS = 60_000;

type Store = PlatformProjectStore;
type Result<Operation extends keyof Store> = Awaited<ReturnType<Store[Operation]>>;

// Operations run to completion once delivered; a caller that gives up only stops waiting for the result.
const uncancelled = new AbortController().signal;

/**
 * Owns one computer's storage. Requests routed to the computer run here against that storage, and every other
 * Worker or Durable Object reaches it only through the typed operations below, each executed here as one unit.
 */
export class ComputerRelay extends DurableObject<ConfiguredPlatformRelayBindings> {
    readonly #application = createPlatformWorker();
    #store: Store | null = null;

    readonly #chat = new ComputerChat(this.ctx.storage, (id) => this.#owns(id));

    readonly #uploads = new WebSocketUploadBudget();
    #connections: ReturnType<ComputerRelay["createConnections"]> | undefined;

    constructor(state: DurableObjectState, environment: ConfiguredPlatformRelayBindings) {
        super(state, environment);
        applyDurableObjectMigrations(state.storage, runtimeConnectionDurableObjectMigrations, "connections/");
        applyDurableObjectMigrations(state.storage, computerDurableObjectMigrations);
        state.setWebSocketAutoResponse(
            new WebSocketRequestResponsePair(RUNTIME_HEARTBEAT_MESSAGE, RUNTIME_HEARTBEAT_ACK_MESSAGE),
        );
    }

    private createConnections() {
        const context = createPlatformDurableObjectContext(this.ctx, this.env, {
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
            this.#store = new SqlitePlatformProjectStore(
                computerId,
                new DurableObjectDatabaseAdapter(this.ctx.storage),
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

    readonly #localChannel = (computerId: string, request: Request): Promise<Response> => {
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
                    { error: { code: "project_id_invalid", message: "The Project identifier is invalid" } },
                    { status: 400 },
                );
            }
            const computerId = computerPath.computerId;
            const store = this.#computerStore(computerId);
            if (store === null) {
                return Response.json(
                    { error: { code: "project_id_mismatch", message: "The computer is unavailable" } },
                    { status: 421 },
                );
            }
            requestUrl.pathname = computerPath.requestPathname;
            const routedRequest = new Request(requestUrl, request);
            const environment: ConfiguredPlatformRelayBindings & ComputerPlatformRelayBindings = {
                ...this.env,
                MORTY_LOCAL_CHANNEL: this.#localChannel,
                MORTY_COMPUTER_STORE: store,
                MORTY_COMPUTER_ID: computerId,
            };
            return await this.#application.fetch(routedRequest, environment);
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

    async authenticateHost(computerId: string, tokenHash: string, now: number): Promise<Result<"authenticateHost">> {
        return await this.#operate(computerId).authenticateHost(computerId, tokenHash, now, uncancelled);
    }

    async isHostCredentialActive(
        computerId: string,
        identity: Parameters<Store["isHostCredentialActive"]>[0],
    ): Promise<boolean> {
        return await this.#operate(computerId).isHostCredentialActive(identity, uncancelled);
    }

    async listLinkedDevices(computerId: string): Promise<Result<"listLinkedDevices">> {
        return await this.#operate(computerId).listLinkedDevices(computerId, uncancelled);
    }

    async revokeLinkedDevice(computerId: string, credentialId: string, now: number): Promise<boolean> {
        return await this.#operate(computerId).revokeLinkedDevice(computerId, credentialId, now, uncancelled);
    }

    async createAccessGrant(computerId: string, value: CreateAccessGrant): Promise<boolean> {
        return await this.#operate(computerId).createAccessGrant(value, uncancelled);
    }

    async redeemAccessGrant(computerId: string, value: RedeemAccessGrant): Promise<AccessGrantRedemption> {
        return await this.#operate(computerId).redeemAccessGrant(value, uncancelled);
    }

    async createBrowserCredential(computerId: string, value: CreateBrowserCredential): Promise<boolean> {
        return await this.#operate(computerId).createBrowserCredential(value, uncancelled);
    }

    async revokeBrowserCredential(computerId: string, credentialId: string, now: number): Promise<boolean> {
        return await this.#operate(computerId).revokeBrowserCredential(credentialId, now, uncancelled);
    }

    async updateAgentCatalog(computerId: string, tokenHash: string, agents: string): Promise<boolean> {
        return await this.#operate(computerId).updateAgentCatalog(computerId, tokenHash, agents, uncancelled);
    }

    async isRuntimeActive(computerId: string): Promise<boolean> {
        return await this.#operate(computerId).isRuntimeActive(computerId, uncancelled);
    }

    async readRuntime(computerId: string): Promise<Result<"readRuntime">> {
        return await this.#operate(computerId).readRuntime(computerId, uncancelled);
    }

    async listRuntimes(computerId: string): Promise<Result<"listRuntimes">> {
        return await this.#operate(computerId).listRuntimes(uncancelled);
    }

    async readChannel(computerId: string): Promise<Result<"readChannel">> {
        return await this.#operate(computerId).readChannel(computerId, uncancelled);
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

    async lastDaemonRevocation(computerId: string): Promise<number | null> {
        return this.#operate(computerId).lastDaemonRevocation(uncancelled);
    }

    async recordAudit(computerId: string, audit: PlatformAuditRecord): Promise<void> {
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
                            const { sessionAccess } = createPlatformAccessServices(this.env);
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
            const environment = {
                ...this.env,
                MORTY_COMPUTER_ID: current.computerId,
                MORTY_LOCAL_CHANNEL: this.#localChannel,
                MORTY_COMPUTER_STORE: this.#operate(current.computerId),
                MORTY_RUNTIME_EXECUTION: {
                    computerId: current.computerId,
                    operations: createLocalSessionOperations(this.#connectionsForComputer.context, current.computerId),
                },
            };
            const response = await this.#application.fetch(request, environment);
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
