import { createStore } from "zustand/vanilla";
import type { BotChatApi, BotRuntimeConfiguration } from "../../services/chat/bot-chat-api.ts";
import { type AnonymousIdentity, AnonymousIdentityApi } from "../../services/identity/anonymous-identity-api.ts";
import type { IdentityScope } from "../../services/identity/identity-scope-url.ts";
import {
    computerAddress,
    computerKey,
    rememberComputerName,
    rememberedComputers,
} from "../../services/identity/remembered-computers.ts";

import { directoryName } from "./directory-name.ts";

export interface ComputerChoice {
    readonly key: string;
    readonly name: string;
    readonly href: string;
    readonly directory: string | null;
    readonly directoryName: string | null;
    readonly lastUsedAt: number;
    readonly status: "online" | "offline" | "unavailable";
}

type ComputerChoicesState =
    | { readonly kind: "loading"; readonly choices: readonly ComputerChoice[] }
    | { readonly kind: "ready"; readonly choices: readonly ComputerChoice[] };

export type ComputerSwitcherModel = ReturnType<typeof createComputerSwitcher>;

export function createComputerSwitcher(options: {
    readonly active: IdentityScope;
    readonly origin: string;
    readonly fetchRequest: (request: Request) => Promise<Response>;
    readonly requests: (identity: AnonymousIdentity) => BotChatApi;
}) {
    const api = new AnonymousIdentityApi(options);
    const store = createStore<ComputerChoicesState>(() => ({ kind: "loading", choices: [] }));
    const activeKey = computerKey(options.active);
    let attempt: AbortController | null = null;
    let disposed = false;
    let current: BotRuntimeConfiguration | null = null;
    const applyCurrent = (choices: readonly ComputerChoice[]): readonly ComputerChoice[] =>
        choices.map((choice) => {
            if (choice.key !== activeKey || current === null) {
                return choice;
            }
            return {
                ...choice,
                name: current.runtime.machineName || choice.name,
                status: current.runtime.online ? "online" : "offline",
            };
        });
    return {
        store,
        activeKey,
        updateCurrent: (configuration: BotRuntimeConfiguration) => {
            current = configuration;
            rememberComputerName(options.active, configuration.runtime.machineName);
            store.setState((state) => ({ ...state, choices: applyCurrent(state.choices) }));
        },
        refresh: async (): Promise<void> => {
            if (disposed) {
                return;
            }
            attempt?.abort(new DOMException("Computer list refresh replaced", "AbortError"));
            const controller = new AbortController();
            attempt = controller;
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
            store.setState((state) => ({ kind: "loading", choices: state.choices }));
            try {
                const choices = await Promise.all(
                    rememberedComputers().map(async (computer): Promise<ComputerChoice | null> => {
                        const choice: ComputerChoice = {
                            key: computerKey(computer.scope),
                            name: computer.name || "Computer",
                            href: computerAddress(computer.scope, computer.destination),
                            directory: computer.directory,
                            directoryName: computer.directory === null ? null : directoryName(computer.directory),
                            lastUsedAt: computer.lastUsedAt,
                            status: "unavailable",
                        };
                        try {
                            const identity = await api.loadScope(computer.scope, signal);
                            signal.throwIfAborted();
                            if (identity === null) {
                                return null;
                            }
                            const requests = options.requests(identity);
                            try {
                                const bot = await requests.readBot(identity.botId, signal);
                                signal.throwIfAborted();
                                if (!bot.configured) {
                                    return choice;
                                }
                                const configuration = await requests.runtimeConfiguration(identity.botId, signal);
                                signal.throwIfAborted();
                                rememberComputerName(identity, configuration.runtime.machineName);
                                return {
                                    ...choice,
                                    name: configuration.runtime.machineName || choice.name,
                                    status: configuration.runtime.online ? "online" : "offline",
                                };
                            } finally {
                                requests.close();
                            }
                        } catch {
                            controller.signal.throwIfAborted();
                            // An unavailable service is not evidence that access ended.
                            return choice;
                        }
                    }),
                );
                controller.signal.throwIfAborted();
                store.setState({ kind: "ready", choices: applyCurrent(choices.filter((choice) => choice !== null)) });
            } catch {
                if (!controller.signal.aborted) {
                    store.setState((state) => ({ kind: "ready", choices: state.choices }));
                }
            } finally {
                if (attempt === controller) {
                    attempt = null;
                }
            }
        },
        dispose: () => {
            disposed = true;
            attempt?.abort(new DOMException("Computer switcher disposed", "AbortError"));
            attempt = null;
        },
    };
}
