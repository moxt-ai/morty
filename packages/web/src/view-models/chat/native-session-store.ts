import type { NativeSessionEntry, NativeSessionResult } from "@moxt-ai/mobius-sdk/channel";
import { createStore } from "zustand/vanilla";
import type { BotChatApi, ChatRuntime, ManagedChatSession } from "../../services/chat/bot-chat-api.ts";
import { formatError } from "../format-error.ts";
import { harnessValue, type NativeSessionAgent, nativeSessionAgentTabs } from "./native-session-agents.ts";
import type { OpenMobiusSession } from "./open-session.ts";
import { type SessionMessage, sessionEventLogPresentation } from "./session-presentation.ts";

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
          readonly entries: readonly NativeSessionEntry[];
          readonly nextCursor: string | null;
      }
    | { readonly kind: "failed"; readonly message: string }
    | { readonly kind: "agent-unavailable"; readonly agentLabel: string };

type NativeSessionPreview =
    | { readonly kind: "empty" }
    | { readonly kind: "loading"; readonly entry: NativeSessionEntry }
    | {
          readonly kind: "ready";
          readonly entry: NativeSessionEntry;
          readonly content: {
              readonly messages: readonly SessionMessage[];
              readonly truncated: boolean;
          };
      }
    | { readonly kind: "failed"; readonly entry: NativeSessionEntry; readonly message: string };

type Operation = "idle" | "more" | "import" | "fork";

type ForkIntent = {
    readonly target: string;
    readonly operationId: string;
};

export interface NativeSessionStore {
    /** The agent tab the user chose, by `runtimeId:agentRef`; the tabs themselves come from the Runtime configuration. */
    readonly selected: string;
    readonly directory: NativeSessionDirectory;
    readonly preview: NativeSessionPreview;
    readonly operation: Operation;
    readonly forkIntent: ForkIntent | null;
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
    readonly selectAgent: (value: string) => void;
    readonly select: (entry: NativeSessionEntry, signal: AbortSignal) => Promise<void>;
    readonly open: (action: "import" | "fork", signal: AbortSignal) => Promise<void>;
    readonly more: (signal: AbortSignal) => Promise<void>;
    readonly dispose: () => void;
}

/** Linked native entries use the same current Session titles as the sidebar, without caching a presentation. */
export function nativeSessionPresentation(model: NativeSessionStore, sessions: readonly ManagedChatSession[]) {
    const present = (entry: NativeSessionEntry) => {
        // Several Morty Sessions can link to one native session; prefer the most recently updated one.
        const linked = sessions
            .filter((session) => entry.mobiusSessionIds.includes(session.id) && session.title.trim().length > 0)
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
        return { ...entry, displayTitle: linked[0]?.title ?? (entry.title || "Untitled session") };
    };
    return {
        ...model,
        directory:
            model.directory.kind === "ready"
                ? { ...model.directory, entries: model.directory.entries.map(present) }
                : model.directory,
        preview:
            model.preview.kind === "empty" ? model.preview : { ...model.preview, entry: present(model.preview.entry) },
    };
}

/** The agent tab a listing is for: the chosen tab while the Runtime still offers it, else the first installed one. */
function chosenAgent(agents: readonly NativeSessionAgent[], selected: string): NativeSessionAgent | undefined {
    return agents.find((item) => item.value === selected) ?? agents.find((item) => item.installed) ?? agents[0];
}

/**
 * The listed entry a relisting should keep previewing: the one the user was reading, recognised across
 * listings by the strongest identity the entries carry. Entry ids are per-listing for some agents, so
 * the native session id and finally the title within its directory stand in for them.
 */
function relistMatch(
    entries: readonly NativeSessionEntry[],
    previewed: NativeSessionEntry | null,
): NativeSessionEntry | undefined {
    if (previewed === null) {
        return undefined;
    }
    return (
        entries.find((entry) => entry.entryId === previewed.entryId) ??
        entries.find((entry) => entry.nativeSessionId === previewed.nativeSessionId) ??
        entries.find((entry) => entry.title === previewed.title && entry.directoryId === previewed.directoryId)
    );
}

/** What a listing shows for an agent, to tell whether the Runtime configuration still matches it. */
function listingFor(agent: NativeSessionAgent | undefined): string {
    return agent === undefined ? "empty" : `${agent.installed ? "ready" : "agent-unavailable"}:${agent.value}`;
}

export const createNativeSessionStore = (
    botId: string,
    requests: Pick<BotChatApi, "nativeSessions" | "nativeSession" | "forkNativeSession">,
    /** The Runtime the page follows, the one owner of which agents it offers. */
    runtime: () => ChatRuntime | null,
    onOpen: (session: OpenMobiusSession) => void,
) => {
    let selection: AbortController | null = null;
    let discovery: AbortController | null = null;
    const lifetime = new AbortController();
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
        forkIntent: null,
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
            const previewed = get().preview;
            const previewedEntry = previewed.kind === "empty" ? null : previewed.entry;
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
                const selected = agent.value;
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
                const entries = result.entries;
                set({
                    directory: {
                        kind: "ready",
                        runtimeId: agent.runtimeId,
                        discoveryId: result.sessionId,
                        agentRef: agent.agentRef,
                        capabilities: result.capabilities,
                        entries,
                        nextCursor: result.nextCursor,
                    },
                });
                // A listing always lands with a previewed session: the one the user was reading when it is still
                // listed, else its first entry. Opening the dialog and switching agent tabs would otherwise leave
                // the whole right pane empty even though there is a session to show.
                const next = relistMatch(entries, previewedEntry) ?? entries[0];
                if (next !== undefined) {
                    // Only the dialog's lifetime cancels this preview. A discovery restart must not abort it, or a
                    // Runtime configuration refresh right after opening would strand the pane on its skeleton.
                    void get().select(next, lifetime.signal);
                }
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
                        ? `ready:${harnessValue(directory.runtimeId, directory.agentRef)}`
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
            set({ preview: { kind: "loading", entry }, error: "" });
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
                        entry,
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
                            entry,
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
                const input = {
                    agentId: directory.agentRef,
                    directoryId: preview.entry.directoryId,
                    additionalDirectoryIds: preview.entry.additionalDirectories.map((item) => item.directoryId),
                    nativeSessionId: preview.entry.nativeSessionId,
                };
                const retained = get().forkIntent;
                const target = JSON.stringify([directory.runtimeId, input]);
                const forkIntent =
                    retained !== null && retained.target === target
                        ? retained
                        : { target, operationId: crypto.randomUUID() };
                if (action === "fork") {
                    set({ forkIntent });
                }
                const result =
                    action === "fork"
                        ? await requests.forkNativeSession(
                              botId,
                              directory.runtimeId,
                              forkIntent.operationId,
                              input,
                              signal,
                          )
                        : await requests.nativeSessions(
                              botId,
                              directory.runtimeId,
                              {
                                  action,
                                  discoveryId: directory.discoveryId,
                                  agentId: directory.agentRef,
                                  directoryId: preview.entry.directoryId,
                                  additionalDirectoryIds: preview.entry.additionalDirectories.map(
                                      (item) => item.directoryId,
                                  ),
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
                        ],
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
