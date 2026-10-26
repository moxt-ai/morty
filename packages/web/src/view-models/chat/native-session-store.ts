import type { NativeSessionEntry, NativeSessionResult } from "@moxt-ai/mobius-sdk/channel";
import { createStore } from "zustand/vanilla";
import type { BotChatApi, ChatRuntime } from "../../services/chat/bot-chat-api.ts";
import { formatError } from "../format-error.ts";
import { type NativeSessionAgent, nativeSessionAgentTabs } from "./native-session-agents.ts";
import type { OpenMobiusSession } from "./open-session.ts";
import { type SessionMessage, sessionEventLogPresentation } from "./session-presentation.ts";

type NativeSessionDisplayEntry = NativeSessionEntry & { readonly displayTitle: string };

type NativeSessionDirectory =
    | {
          readonly kind: "loading";
          readonly scope: "initial" | "refresh";
          /** The listing the request in flight is for, or null while the page waits for the Runtime. */
          readonly listing: string | null;
      }
    | { readonly kind: "empty" }
    | {
          readonly kind: "ready";
          readonly runtimeId: string;
          readonly discoveryId: string;
          readonly agentRef: string;
          readonly capabilities: Extract<NativeSessionResult, { readonly action: "list" }>["capabilities"];
          readonly entries: readonly NativeSessionDisplayEntry[];
          readonly nextCursor: string | null;
      }
    | { readonly kind: "failed"; readonly message: string }
    | { readonly kind: "agent-unavailable"; readonly agentLabel: string };

type NativeSessionPreview =
    | { readonly kind: "empty" }
    | { readonly kind: "loading"; readonly entry: NativeSessionDisplayEntry }
    | {
          readonly kind: "ready";
          readonly entry: NativeSessionDisplayEntry;
          readonly content: {
              readonly messages: readonly SessionMessage[];
              readonly truncated: boolean;
          };
      }
    | { readonly kind: "failed"; readonly entry: NativeSessionDisplayEntry; readonly message: string };

type Operation = "idle" | "more" | "import" | "fork";

export interface NativeSessionStore {
    /** The agent tab the user chose, by `runtimeId:agentRef`; the tabs themselves come from the Runtime configuration. */
    readonly selected: string;
    readonly directory: NativeSessionDirectory;
    readonly preview: NativeSessionPreview;
    readonly operation: Operation;
    readonly error: string;
    /** Starts discovery when the dialog opens. */
    readonly start: () => void;
    /** The signal of the dialog's discovery lifetime. */
    readonly lifetimeSignal: () => AbortSignal;
    /** Stops discovery and preview requests when the dialog closes. */
    readonly stop: () => void;
    readonly load: (signal: AbortSignal) => Promise<void>;
    /** The Runtime configuration the page follows changed: the listing follows the agent it now offers. */
    readonly runtimeChanged: () => void;
    readonly titlesChanged: () => void;
    readonly selectAgent: (value: string) => void;
    readonly select: (entry: NativeSessionEntry, signal: AbortSignal) => Promise<void>;
    readonly open: (action: "import" | "fork", signal: AbortSignal) => Promise<void>;
    readonly more: (signal: AbortSignal) => Promise<void>;
    readonly dispose: () => void;
}

/** The agent tab a listing is for: the chosen tab while the Runtime still offers it, else the first installed one. */
function chosenAgent(agents: readonly NativeSessionAgent[], selected: string): NativeSessionAgent | undefined {
    return (
        agents.find((item) => `${item.runtimeId}:${item.agentRef}` === selected) ??
        agents.find((item) => item.installed) ??
        agents[0]
    );
}

/** What a listing shows for an agent, to tell whether the Runtime configuration still matches it. */
function listingFor(agent: NativeSessionAgent | undefined): string {
    return agent === undefined
        ? "empty"
        : `${agent.installed ? "ready" : "agent-unavailable"}:${agent.runtimeId}:${agent.agentRef}`;
}

export const createNativeSessionStore = (
    botId: string,
    requests: Pick<BotChatApi, "nativeSessions" | "nativeSession">,
    /** The Runtime the page follows, the one owner of which agents it offers. */
    runtime: () => ChatRuntime | null,
    displayTitle: (entry: NativeSessionEntry) => string,
    onOpen: (session: OpenMobiusSession) => void,
) => {
    let selection: AbortController | null = null;
    let discovery: AbortController | null = null;
    const lifetime = new AbortController();
    const present = (entry: NativeSessionEntry): NativeSessionDisplayEntry => ({
        ...entry,
        displayTitle: displayTitle(entry),
    });
    return createStore<NativeSessionStore>()((set, get) => ({
        start: () => {
            void get().load(lifetime.signal);
        },
        lifetimeSignal: () =>
            discovery === null ? lifetime.signal : AbortSignal.any([lifetime.signal, discovery.signal]),
        stop: () => {
            lifetime.abort(new Error("The native session dialog closed."));
            get().dispose();
        },
        selected: "",
        directory: { kind: "loading", scope: "initial", listing: null },
        preview: { kind: "empty" },
        operation: "idle",
        error: "",
        load: async (parent) => {
            const current = runtime();
            const agent = current === null ? undefined : chosenAgent(nativeSessionAgentTabs(current), get().selected);
            const listing = current === null ? null : listingFor(agent);
            const before = get().directory;
            // The Runtime runs one native session operation per agent at a time: a request it is still carrying
            // out answers for this listing too, and cancelling it to send the same request again would only be
            // refused as busy.
            if (listing !== null && before.kind === "loading" && before.listing === listing) {
                return;
            }
            const attempt = new AbortController();
            discovery?.abort(new Error("Native session discovery restarted."));
            discovery = attempt;
            const signal = AbortSignal.any([parent, attempt.signal]);
            const scope = get().selected === "" ? ("initial" as const) : ("refresh" as const);
            set({ directory: { kind: "loading", scope, listing }, preview: { kind: "empty" }, error: "" });
            if (current === null) {
                // The page has not heard from the Runtime yet; its first configuration starts the listing.
                return;
            }
            try {
                if (agent === undefined) {
                    set({ directory: { kind: "empty" } });
                    return;
                }
                const selected = `${agent.runtimeId}:${agent.agentRef}`;
                if (!agent.installed) {
                    set({
                        selected,
                        directory: { kind: "agent-unavailable", agentLabel: agent.label },
                        preview: { kind: "empty" },
                    });
                    return;
                }
                set({ selected });
                const result = await requests.nativeSessions(
                    botId,
                    agent.runtimeId,
                    {
                        action: "list",
                        agentId: agent.agentRef,
                        directoryId: "default",
                        additionalDirectoryIds: [],
                        cursor: null,
                        discoveryId: null,
                    },
                    signal,
                );
                signal.throwIfAborted();
                if (result.action !== "list") {
                    throw new Error("The agent returned an unexpected session directory.");
                }
                set({
                    directory: {
                        kind: "ready",
                        runtimeId: agent.runtimeId,
                        discoveryId: result.sessionId,
                        agentRef: agent.agentRef,
                        capabilities: result.capabilities,
                        entries: result.entries.map(present),
                        nextCursor: result.nextCursor,
                    },
                });
            } catch (cause) {
                if (!signal.aborted) {
                    set({
                        directory: {
                            kind: "failed",
                            message: formatError(cause, "Native sessions are unavailable."),
                        },
                    });
                }
            }
        },
        titlesChanged: () => {
            const { directory, preview } = get();
            set({
                directory:
                    directory.kind === "ready" ? { ...directory, entries: directory.entries.map(present) } : directory,
                preview: preview.kind === "empty" ? preview : { ...preview, entry: present(preview.entry) },
            });
        },
        runtimeChanged: () => {
            const current = runtime();
            // An Open, Fork or Load more the user sent keeps running: restarting discovery would cancel a request
            // the Runtime may already be carrying out. Its end checks the listing against the configuration again.
            if (current === null || get().operation !== "idle") {
                return;
            }
            const { directory, selected } = get();
            const shown =
                directory.kind === "empty"
                    ? "empty"
                    : directory.kind === "agent-unavailable"
                      ? `agent-unavailable:${selected}`
                      : directory.kind === "ready"
                        ? `ready:${directory.runtimeId}:${directory.agentRef}`
                        : directory.kind === "loading"
                          ? directory.listing
                          : null;
            if (shown !== listingFor(chosenAgent(nativeSessionAgentTabs(current), selected))) {
                void get().load(lifetime.signal);
            }
        },
        selectAgent: (selected) => {
            set({ selected });
            void get().load(lifetime.signal);
        },
        select: async (entry, lifetimeSignal) => {
            const { directory, operation } = get();
            if (directory.kind !== "ready" || operation !== "idle") {
                return;
            }
            selection?.abort();
            selection = new AbortController();
            const signal = AbortSignal.any([selection.signal, lifetimeSignal]);
            set({ preview: { kind: "loading", entry: present(entry) }, error: "" });
            try {
                const content = await requests.nativeSession(
                    botId,
                    directory.runtimeId,
                    {
                        agentId: directory.agentRef,
                        directoryId: entry.directoryId,
                        additionalDirectoryIds: entry.additionalDirectories.map((item) => item.directoryId),
                        entryId: entry.entryId,
                        nativeSessionId: entry.nativeSessionId,
                    },
                    signal,
                );
                signal.throwIfAborted();
                const events = content.events.events;
                set({
                    preview: {
                        kind: "ready",
                        entry: present(entry),
                        content: {
                            messages: sessionEventLogPresentation(events).messages,
                            truncated: content.events.truncated,
                        },
                    },
                });
            } catch (cause) {
                if (!signal.aborted) {
                    set({
                        preview: {
                            kind: "failed",
                            entry: present(entry),
                            message: formatError(cause, "The preview could not be loaded."),
                        },
                    });
                }
            }
        },
        open: async (action, signal) => {
            const { directory, preview, operation } = get();
            if (directory.kind !== "ready" || preview.kind !== "ready" || operation !== "idle") {
                return;
            }
            set({ operation: action, error: "" });
            try {
                const result = await requests.nativeSessions(
                    botId,
                    directory.runtimeId,
                    {
                        action,
                        discoveryId: directory.discoveryId,
                        agentId: directory.agentRef,
                        directoryId: preview.entry.directoryId,
                        additionalDirectoryIds: preview.entry.additionalDirectories.map((item) => item.directoryId),
                        entryId: preview.entry.entryId,
                    },
                    signal,
                );
                signal.throwIfAborted();
                if (result.action !== action) {
                    throw new Error(`This agent cannot ${action} the selected native session.`);
                }
                onOpen({
                    agentRef: directory.agentRef,
                    result,
                    entry: preview.entry,
                });
                // A successful open unmounts the dialog, so end the discovery
                // lifetime here; its close path never runs.
                get().stop();
            } catch (cause) {
                if (!signal.aborted) {
                    set({ error: formatError(cause, `The session could not be ${action}ed.`) });
                }
            } finally {
                if (!signal.aborted) {
                    set({ operation: "idle" });
                    get().runtimeChanged();
                }
            }
        },
        more: async (signal) => {
            const { directory, operation } = get();
            if (directory.kind !== "ready" || directory.nextCursor === null || operation !== "idle") {
                return;
            }
            set({ operation: "more", error: "" });
            try {
                const result = await requests.nativeSessions(
                    botId,
                    directory.runtimeId,
                    {
                        action: "list",
                        agentId: directory.agentRef,
                        directoryId: "default",
                        additionalDirectoryIds: [],
                        cursor: directory.nextCursor,
                        discoveryId: directory.discoveryId,
                    },
                    signal,
                );
                signal.throwIfAborted();
                if (result.action !== "list") {
                    throw new Error("The agent returned an unexpected session directory.");
                }
                set({
                    directory: {
                        ...directory,
                        entries: [
                            ...directory.entries,
                            ...result.entries.filter(
                                (entry) => !directory.entries.some((existing) => existing.entryId === entry.entryId),
                            ),
                        ].map(present),
                        nextCursor: result.nextCursor,
                    },
                });
            } catch (cause) {
                if (!signal.aborted) {
                    set({ error: formatError(cause, "More sessions could not be loaded.") });
                }
            } finally {
                if (!signal.aborted) {
                    set({ operation: "idle" });
                    get().runtimeChanged();
                }
            }
        },
        dispose: () => {
            selection?.abort();
            selection = null;
        },
    }));
};
