import type { MobiusTurn, SubmitMobiusTurnRequest } from "@moxt-ai/mobius-sdk";
import { SessionPromptDisposition } from "@moxt-ai/mobius-sdk";
import { createStore } from "zustand/vanilla";
import { formatError } from "../format-error.ts";

interface ActiveTurn {
    readonly commandId: string;
    readonly turnId: string;
}

type TaskControlOperation =
    | { readonly kind: "idle" }
    | { readonly kind: "running"; readonly active: ActiveTurn }
    | { readonly kind: "steering"; readonly active: ActiveTurn }
    | { readonly kind: "stopping"; readonly active: ActiveTurn };

type TaskControlFeedback = { readonly kind: "none" } | { readonly kind: "failed"; readonly message: string };

interface TaskControlPort {
    readonly cancel: (turnId: string, idempotencyKey: string, signal: AbortSignal) => Promise<MobiusTurn>;
    readonly submit: (request: SubmitMobiusTurnRequest, signal: AbortSignal) => Promise<{ readonly turnId: string }>;
}

export interface SessionTaskControlsStore {
    readonly feedback: TaskControlFeedback;
    readonly operation: TaskControlOperation;
    readonly steeringSupported: boolean;
    readonly dismissFailure: () => void;
    readonly finish: (commandId: string) => void;
    readonly start: (commandId: string, turnId: string) => void;
    readonly steer: (
        content: string,
        request: Omit<SubmitMobiusTurnRequest, "content" | "disposition" | "idempotencyKey" | "targetCommandId">,
        onStarted: (commandId: string, prompt: string) => void,
        signal: AbortSignal,
    ) => Promise<{ readonly commandId: string } | null>;
    readonly stop: (signal: AbortSignal) => Promise<void>;
}

export const createSessionTaskControlsStore = (options: {
    readonly port: TaskControlPort;
    readonly steeringSupported: boolean;
}) =>
    createStore<SessionTaskControlsStore>()((set, get) => ({
        feedback: { kind: "none" },
        operation: { kind: "idle" },
        steeringSupported: options.steeringSupported,
        dismissFailure: () => set({ feedback: { kind: "none" } }),
        finish: (commandId) => {
            const operation = get().operation;
            if (
                (operation.kind === "running" || operation.kind === "steering" || operation.kind === "stopping") &&
                operation.active.commandId === commandId
            ) {
                set({ operation: { kind: "idle" } });
            }
        },
        start: (commandId, turnId) =>
            set({ feedback: { kind: "none" }, operation: { active: { commandId, turnId }, kind: "running" } }),
        steer: async (content, request, onStarted, parent) => {
            const state = get();
            const prompt = content.trim();
            if (state.operation.kind !== "running" || !state.steeringSupported || prompt.length === 0) {
                return null;
            }
            const active = state.operation.active;
            const commandId = crypto.randomUUID();
            const signal = AbortSignal.any([parent, AbortSignal.timeout(45_000)]);
            set({ feedback: { kind: "none" }, operation: { active, kind: "steering" } });
            onStarted(commandId, prompt);
            try {
                await options.port.submit(
                    {
                        ...request,
                        content: prompt,
                        disposition: SessionPromptDisposition.Steer,
                        idempotencyKey: commandId,
                        targetCommandId: active.commandId,
                    },
                    signal,
                );
                signal.throwIfAborted();
                const operation = get().operation;
                if (operation.kind === "steering" && operation.active.commandId === active.commandId) {
                    set({ operation: { active, kind: "running" } });
                }
                return { commandId };
            } catch (cause) {
                if (parent.aborted) {
                    throw cause;
                }
                // The turn can end while the request is in flight; its failure then has nothing left to restore.
                const operation = get().operation;
                if (operation.kind !== "steering" || operation.active.commandId !== active.commandId) {
                    return null;
                }
                set({
                    feedback: { kind: "failed", message: formatError(cause, "The active task could not be steered.") },
                    operation: { active, kind: "running" },
                });
                return null;
            }
        },
        stop: async (parent) => {
            const state = get();
            if (state.operation.kind !== "running") {
                return;
            }
            const active = state.operation.active;
            const signal = AbortSignal.any([parent, AbortSignal.timeout(15_000)]);
            set({ feedback: { kind: "none" }, operation: { active, kind: "stopping" } });
            try {
                await options.port.cancel(active.turnId, crypto.randomUUID(), signal);
            } catch (cause) {
                if (signal.aborted && parent.aborted) {
                    throw cause;
                }
                // The turn can end while the request is in flight; its failure then has nothing left to restore.
                const operation = get().operation;
                if (operation.kind !== "stopping" || operation.active.commandId !== active.commandId) {
                    return;
                }
                set({
                    feedback: {
                        kind: "failed",
                        message: formatError(cause, "The agent output could not be stopped."),
                    },
                    operation: { active, kind: "running" },
                });
            }
        },
    }));
