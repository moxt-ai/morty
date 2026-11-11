import type { ForkMortyNativeSessionRequest } from "@morty-build/client";
import type {
    AgentSettingsDiscoverCommand,
    NativeSessionTarget,
    SessionAccessHolder,
    WorkspaceListCommand,
} from "@morty-build/client/protocol";
import { decodeComputerDiagnosticsRequest } from "@morty-build/client/protocol";
import { hashSecret, PairingDirectoryError } from "../../../../contracts/relay/pairing.ts";
import type { RelayContext } from "../../../composition/relay-services.ts";
import type { ComputerControlCommand } from "../../runtime/service/computer-control-request.ts";
import type { LocalSessionOperations } from "../../runtime/service/local-session-operations.ts";
import type { SessionAccessService } from "../../runtime/service/session-access-service.ts";
import { SessionControl } from "../../runtime/service/session-control.ts";

/** Only constructed inside the ComputerRelay that owns these Computer operations. */
export class ComputerBackendService {
    readonly computerId: string;
    readonly #context: RelayContext;
    readonly #sessionAccess: SessionAccessService;
    readonly #pairingRoot: string;
    private readonly operations: LocalSessionOperations;
    constructor(
        computerId: string,
        context: RelayContext,
        sessionAccess: SessionAccessService,
        pairingRoot: string,
        operations: LocalSessionOperations,
    ) {
        this.computerId = computerId;
        this.#context = context;
        this.#sessionAccess = sessionAccess;
        this.#pairingRoot = pairingRoot;
        this.operations = operations;
    }

    // Pairing retries derive the same code without storing or transporting a service credential.
    readonly createPairing = async (idempotencyKey: string, signal: AbortSignal) =>
        await this.#context.services.computerPairings.createProjectComputerPairing(
            this.computerId,
            await hashSecret(`morty.internal.pairing.v1:${this.#pairingRoot}`),
            idempotencyKey,
            signal,
        );
    readonly readPairing = async (signal: AbortSignal) =>
        await this.#context.services.computerPairings.readProjectComputerPairing(this.computerId, signal);
    readonly computers = async (signal: AbortSignal) =>
        await this.#context.services.computerPairings.listProjectComputers(this.computerId, signal);
    readonly agents = async (signal: AbortSignal) =>
        await this.#context.services.computerPairings.getComputerAgents(this.computerId, signal);
    readonly issueSessionAccess = async (
        target: NativeSessionTarget,
        lifetime: number,
        holder: SessionAccessHolder,
        signal: AbortSignal,
    ) =>
        await this.#sessionAccess.issue(
            { kind: "session", computerId: this.computerId, target },
            lifetime,
            holder,
            signal,
        );
    readonly diagnostics = async (signal: AbortSignal) =>
        await this.control(
            decodeComputerDiagnosticsRequest(
                JSON.stringify({ kind: "computer.diagnostics.read", requestId: crypto.randomUUID() }),
            ),
            signal,
        );
    readonly latency = async (signal: AbortSignal): Promise<number> => {
        const command: ComputerControlCommand = { kind: "computer.ping", requestId: `ping_${crypto.randomUUID()}` };
        const access = await this.#context.services.pairings.authorizeProject(this.computerId, signal);
        const started = performance.now();
        await this.operations.requestComputerScopeControl(access.scope, command, signal);
        return Math.max(0, Math.round(performance.now() - started));
    };
    readonly control = async (command: ComputerControlCommand, signal: AbortSignal) => {
        const access = await this.#context.services.pairings.authorizeProject(this.computerId, signal);
        return await this.operations.requestComputerScopeControl(access.scope, command, signal);
    };
    readonly workspace = async (command: WorkspaceListCommand, signal: AbortSignal) => {
        const access = await this.#context.services.pairings.authorizeProject(this.computerId, signal);
        return await this.operations.requestWorkspace(access.scope, command, signal);
    };
    readonly settings = async (command: AgentSettingsDiscoverCommand, signal: AbortSignal) => {
        const computers = await this.#context.services.pairings.listProjectComputers(this.computerId, signal);
        if (!computers.some((computer) => computer.computerId === this.computerId)) {
            throw new PairingDirectoryError(
                "computer_access_denied",
                "The project credential cannot access this Computer",
            );
        }
        const access = await this.#context.services.pairings.authorizeProject(this.computerId, signal);
        return await this.operations.requestAgentSettings(access.scope, command, signal);
    };
    readonly fork = async (operationId: string, input: ForkMortyNativeSessionRequest, signal: AbortSignal) => {
        const access = await this.#context.services.pairings.authorizeProject(this.computerId, signal);
        return await this.operations.forkNativeSession(access.scope, operationId, input, signal);
    };
    readonly session = (target: NativeSessionTarget, signal: AbortSignal) =>
        new SessionControl(async (command) => await this.control(command, signal), target);
}
