import type { SessionEventPayload } from "@morty-build/client/protocol";
import type { AgentProcessPool } from "../../session/process/agent-process-pool.ts";
import { AcpExecutionError } from "../acp-error.ts";
import { agentOperationError, waitForAgentOperation } from "../connection/agent-operation.ts";
import type { NativeSessionPreviewRequest, NativeSessionQuery } from "../native-history/preview-contract.ts";
import { type HistoryPreviewSnapshot, NativeHistoryPreviewSnapshots } from "../native-history/preview-snapshots.ts";
import { sessionIdSchema } from "../protocol/native-session.ts";
import { type HarnessCallbackParams, harnessPreviewCallbacks } from "./harness-client-events.ts";
import { disposeHarnessClient, type HarnessClient, type HarnessLifetime } from "./harness-session.ts";
import { nativeSessionPreviewKey, nativeSessionQueryKey } from "./query-scope.ts";

interface HarnessHistorySource {
    readonly client: HarnessClient;
    readonly load: (sessionId: string, signal: AbortSignal) => Promise<unknown>;
    readonly drained: () => Promise<void>;
}

function unexpectedSnapshotIdentity(identity: never): never {
    throw new AcpExecutionError(
        "Invalid history snapshot identity",
        { cause: identity },
        "invalid_native_session_response",
    );
}

/** Shared read-only snapshot ownership and transient process capacity for replay-based harnesses. */
export class HarnessHistoryPreviews {
    readonly #snapshots: NativeHistoryPreviewSnapshots;
    readonly processes: AgentProcessPool;
    constructor(processes: AgentProcessPool, createSnapshot: () => HistoryPreviewSnapshot) {
        this.processes = processes;
        this.#snapshots = new NativeHistoryPreviewSnapshots(createSnapshot);
    }

    readonly read = async (params: {
        readonly query: NativeSessionQuery;
        readonly request: NativeSessionPreviewRequest;
        readonly identity:
            | { readonly kind: "fresh" }
            | {
                  readonly kind: "content";
                  readonly generationId: (sessionId: string, events: readonly SessionEventPayload[]) => string;
              };
        readonly create: (
            callbacks: HarnessCallbackParams,
            lifetime: HarnessLifetime,
            signal: AbortSignal,
        ) => Promise<HarnessHistorySource>;
    }) => {
        const { query, request } = params;
        query.signal.throwIfAborted();
        const sessionId = sessionIdSchema.parse(request.sessionId);
        const target = { harness: query.agent.harness, sessionId };
        const key = nativeSessionPreviewKey(nativeSessionQueryKey(query), sessionId);
        if (request.cursor !== null) {
            return this.#snapshots.get(key).page(target, request.eventLimit, request.cursor);
        }
        const store = this.#snapshots.replace(key);
        const events: SessionEventPayload[] = [];
        try {
            return await this.processes.runTransient(
                query.signal,
                async () => {
                    const lifetime = new AbortController();
                    const callbacks = harnessPreviewCallbacks(query, async (received, event) => {
                        if (received !== sessionId) {
                            throw new AcpExecutionError(
                                "The harness replayed another session",
                                {},
                                "invalid_agent_session",
                            );
                        }
                        const payload: SessionEventPayload = { type: "acp", payload: event.payload };
                        switch (params.identity.kind) {
                            case "fresh":
                                store.append(target, payload);
                                break;
                            case "content":
                                events.push(payload);
                                break;
                            default:
                                unexpectedSnapshotIdentity(params.identity);
                        }
                    });
                    const source = await params.create(
                        callbacks,
                        { signal: lifetime.signal, fail: (cause) => lifetime.abort(cause) },
                        query.signal,
                    );
                    return {
                        source,
                        lifetime,
                        closeProcess: async () => {
                            try {
                                await disposeHarnessClient(source.client, sessionId, source.drained, "graceful");
                            } finally {
                                lifetime.abort();
                            }
                        },
                    };
                },
                async ({ source, lifetime }) => {
                    const signal = AbortSignal.any([query.signal, lifetime.signal]);
                    await waitForAgentOperation(source.load(sessionId, signal), signal);
                    await waitForAgentOperation(source.drained(), signal);
                    switch (params.identity.kind) {
                        case "fresh":
                            break;
                        case "content":
                            store.materialize(target, params.identity.generationId(sessionId, events), events);
                            break;
                        default:
                            unexpectedSnapshotIdentity(params.identity);
                    }
                    return store.page(target, request.eventLimit, null);
                },
                (runtime) => runtime.closeProcess(),
            );
        } catch (cause) {
            this.#snapshots.discard(key, store);
            throw agentOperationError(cause);
        }
    };
    readonly close = (): void => this.#snapshots.close();
}
