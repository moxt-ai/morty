import type { PromptRequest, PromptResponse } from "@agentclientprotocol/sdk/unstable";
import { AcpExecutionError } from "../acp-error.ts";
import { agentOperationError, waitForAgentOperation } from "../connection/agent-operation.ts";
import { type SessionId, sessionIdSchema } from "../protocol/native-session.ts";

export interface HarnessClient {
    readonly signal: AbortSignal;
    readonly prompt: (request: PromptRequest) => Promise<PromptResponse>;
    readonly cancel: (request: { readonly sessionId: string }) => Promise<void>;
    readonly dispose: () => Promise<void>;
}

export interface HarnessLifetime {
    readonly signal: AbortSignal;
    readonly fail: (cause: unknown) => void;
}

/** Owns one accepted provider session. Vendor adapters supply operations, not lifecycle policy. */
export class HarnessSession<Client extends HarnessClient> {
    readonly sessionId: SessionId;
    readonly workspace: { readonly cwd: string };
    readonly agent: Client;
    readonly #lifetime: AbortController;
    readonly #drained: () => Promise<void>;
    #closing: Promise<void> | null = null;

    private constructor(
        sessionId: SessionId,
        workspace: { readonly cwd: string },
        agent: Client,
        lifetime: AbortController,
        drained: () => Promise<void>,
    ) {
        this.sessionId = sessionId;
        this.workspace = workspace;
        this.agent = agent;
        this.#lifetime = lifetime;
        this.#drained = drained;
    }

    static readonly start = async <Client extends HarnessClient, Response extends { readonly sessionId: string }>(
        params: {
            readonly workspace: { readonly cwd: string };
            readonly signal: AbortSignal;
            readonly create: (
                lifetime: HarnessLifetime,
            ) => Promise<{ readonly agent: Client; readonly drained: () => Promise<void> }>;
        },
        open: (agent: Client, signal: AbortSignal) => Promise<Response>,
    ): Promise<{ readonly session: HarnessSession<Client>; readonly response: Response }> => {
        params.signal.throwIfAborted();
        const lifetime = new AbortController();
        const { agent, drained } = await params.create({
            signal: lifetime.signal,
            fail: (cause) => lifetime.abort(cause),
        });
        try {
            const signal = AbortSignal.any([params.signal, lifetime.signal]);
            signal.throwIfAborted();
            const response = await waitForAgentOperation(open(agent, signal), signal);
            await waitForAgentOperation(drained(), signal);
            return {
                session: new HarnessSession(
                    sessionIdSchema.parse(response.sessionId),
                    params.workspace,
                    agent,
                    lifetime,
                    drained,
                ),
                response,
            };
        } catch (cause) {
            lifetime.abort(cause);
            await agent.dispose();
            params.signal.throwIfAborted();
            throw agentOperationError(cause);
        }
    };

    get available(): boolean {
        return !this.#lifetime.signal.aborted && !this.agent.signal.aborted;
    }

    readonly assertWorkspace = (workspace: { readonly cwd: string }): void => {
        if (this.workspace.cwd !== workspace.cwd) {
            throw new AcpExecutionError("The session workspace cannot change", {}, "session_identity_mismatch");
        }
    };

    /** Success includes delivery of every turn event; cancellation and delivery failure stop the turn. */
    readonly prompt = async (
        request: Omit<PromptRequest, "sessionId">,
        signal: AbortSignal,
    ): Promise<PromptResponse> => {
        signal.throwIfAborted();
        this.#lifetime.signal.throwIfAborted();
        const stopped = AbortSignal.any([signal, this.#lifetime.signal]);
        const stopTurn = (): void => {
            if (!this.agent.signal.aborted) {
                void this.cancel(new AbortController().signal).catch(() => undefined);
            }
        };
        stopped.addEventListener("abort", stopTurn, { once: true });
        try {
            const response = await waitForAgentOperation(
                this.agent.prompt({ ...request, sessionId: this.sessionId }),
                stopped,
            );
            await waitForAgentOperation(this.#drained(), stopped);
            return response;
        } catch (cause) {
            signal.throwIfAborted();
            this.#lifetime.signal.throwIfAborted();
            await waitForAgentOperation(this.#drained(), stopped);
            throw cause;
        } finally {
            stopped.removeEventListener("abort", stopTurn);
        }
    };

    readonly cancel = async (signal: AbortSignal): Promise<"retained" | "closed"> => {
        signal.throwIfAborted();
        const deadline = AbortSignal.timeout(30_000);
        try {
            await waitForAgentOperation(
                this.agent.cancel({ sessionId: this.sessionId }),
                AbortSignal.any([signal, deadline]),
            );
            return "retained";
        } catch (cause) {
            signal.throwIfAborted();
            if (!deadline.aborted) {
                throw cause;
            }
            await this.dispose();
            return "closed";
        }
    };

    readonly dispose = (): Promise<void> => {
        if (this.#closing === null) {
            this.#closing = this.agent.dispose();
            this.#lifetime.abort(new DOMException("The harness session was released", "AbortError"));
        }
        return this.#closing;
    };
}
