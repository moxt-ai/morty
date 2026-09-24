import type { SessionCommand, SubmitMobiusTurnRequest } from "@moxt-ai/mobius-sdk";
import { SessionPromptDisposition } from "@moxt-ai/mobius-sdk";
import { createStore } from "zustand/vanilla";

interface ActiveTurn {
    readonly commandId: string;
    readonly turnId: string;
}

type TaskControlOperation =
    | { readonly kind: "idle" }
    | { readonly kind: "running"; readonly active: ActiveTurn }
    | { readonly kind: "steering"; readonly active: ActiveTurn }
    | { readonly kind: "stopping"; readonly active: ActiveTurn }
    | { readonly kind: "compacting"; readonly commandId: string };

type TaskControlFeedback = { readonly kind: "none" } | { readonly kind: "failed"; readonly message: string };

interface TaskControlPort {
    readonly cancel: (turnId: string, idempotencyKey: string, signal: AbortSignal) => Promise<unknown>;
    readonly submit: (request: SubmitMobiusTurnRequest, signal: AbortSignal) => Promise<{ readonly turnId: string }>;
}

export interface SessionTaskControlsStore {
    readonly commands: readonly SessionCommand[];
    readonly feedback: TaskControlFeedback;
    readonly operation: TaskControlOperation;
    readonly steeringSupported: boolean;
    readonly compact: (
        request: Omit<SubmitMobiusTurnRequest, "content" | "disposition" | "idempotencyKey" | "targetCommandId">,
        onStarted: (commandId: string, prompt: string) => void,
        signal: AbortSignal,
    ) => Promise<{ readonly commandId: string; readonly prompt: string; readonly turnId: string } | null>;
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
    readonly updateCommands: (commands: readonly SessionCommand[]) => void;
}

function errorMessage(cause: unknown, fallback: string): string {
    return cause instanceof Error ? cause.message : fallback;
}

function compactCommand(commands: readonly SessionCommand[]): SessionCommand | null {
    return commands.find((command) => command.name.toLowerCase() === "compact") ?? null;
}

export const createSessionTaskControlsStore = (options: {
    readonly commands: readonly SessionCommand[];
    readonly port: TaskControlPort;
    readonly steeringSupported: boolean;
}) =>
    createStore<SessionTaskControlsStore>()((set, get) => ({
        commands: options.commands,
        feedback: { kind: "none" },
        operation: { kind: "idle" },
        steeringSupported: options.steeringSupported,
        compact: async (request, onStarted, parent) => {
            const state = get();
            const command = compactCommand(state.commands);
            if (state.operation.kind !== "idle" || command === null) {
                return null;
            }
            const commandId = crypto.randomUUID();
            const prompt = `/${command.name}`;
            const signal = AbortSignal.any([parent, AbortSignal.timeout(120_000)]);
            set({ feedback: { kind: "none" }, operation: { commandId, kind: "compacting" } });
            onStarted(commandId, prompt);
            try {
                const accepted = await options.port.submit(
                    { ...request, content: prompt, idempotencyKey: commandId },
                    signal,
                );
                signal.throwIfAborted();
                const operation = get().operation;
                if (operation.kind === "compacting" && operation.commandId === commandId) {
                    set({ operation: { active: { commandId, turnId: accepted.turnId }, kind: "running" } });
                }
                return { commandId, prompt, turnId: accepted.turnId };
            } catch (cause) {
                if (parent.aborted) {
                    throw cause;
                }
                set({
                    feedback: { kind: "failed", message: errorMessage(cause, "The context could not be compacted.") },
                    operation: { kind: "idle" },
                });
                return null;
            }
        },
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
                set({
                    feedback: { kind: "failed", message: errorMessage(cause, "The active task could not be steered.") },
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
                set({
                    feedback: {
                        kind: "failed",
                        message: errorMessage(cause, "The agent output could not be stopped."),
                    },
                    operation: { active, kind: "running" },
                });
            }
        },
        updateCommands: (commands) => set({ commands }),
    }));

export function findCompactCommand(commands: readonly SessionCommand[]): SessionCommand | null {
    return compactCommand(commands);
}
