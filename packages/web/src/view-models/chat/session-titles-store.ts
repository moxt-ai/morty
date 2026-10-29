import { createStore } from "zustand/vanilla";
import type { ManagedChatSession } from "../../services/chat/bot-chat-api.ts";
import {
    centralSessionStorage,
    rememberedSessionEntry,
} from "../../services/session-storage/central-session-storage.ts";

type SessionTitle = {
    readonly kind: "known" | "created";
    readonly title: string;
};

export type SessionTitles = ReadonlyMap<string, SessionTitle>;
export type SessionTitlesStore = Omit<ReturnType<typeof createSessionTitlesStore>, "setState">;

export function sessionTitle(titles: SessionTitles, sessionId: string, fallback = "Untitled session"): string {
    return titles.get(sessionId)?.title ?? fallback;
}

/** One display title per Session. The Runtime is authoritative; in-flight reads cannot undo newer observations. */
export function createSessionTitlesStore(identityKey: string | null) {
    let rememberedId: string | null = null;
    return createStore<{
        readonly titles: SessionTitles;
        readonly restore: () => void;
        readonly remember: (sessionId: string) => void;
        readonly forget: (sessionId: string) => void;
        readonly observed: (sessionId: string, title: string) => void;
        readonly created: (sessionId: string, title: string) => void;
        readonly sessionLoaded: (sessionId: string, title: string, startedWith: SessionTitles) => void;
        readonly directoryLoaded: (sessions: readonly ManagedChatSession[], startedWith: SessionTitles) => void;
    }>()((set, get) => {
        const persist = (): void => {
            if (identityKey === null || rememberedId === null) {
                return;
            }
            const title = get().titles.get(rememberedId)?.title;
            if (title !== undefined && title.length > 0) {
                centralSessionStorage.write(rememberedSessionEntry(identityKey), { id: rememberedId, title });
            }
        };
        const put = (sessionId: string, value: SessionTitle): void => {
            set((state) => ({ titles: new Map(state.titles).set(sessionId, value) }));
            if (rememberedId === sessionId) {
                persist();
            }
        };
        return {
            titles: new Map(),
            restore: () => {
                if (identityKey === null || rememberedId !== null) {
                    return;
                }
                const saved = centralSessionStorage.read(rememberedSessionEntry(identityKey));
                if (saved !== null) {
                    rememberedId = saved.id;
                    if (!get().titles.has(saved.id)) {
                        set((state) => ({
                            titles: new Map(state.titles).set(saved.id, { kind: "known", title: saved.title }),
                        }));
                    }
                }
            },
            remember: (sessionId) => {
                rememberedId = sessionId;
                persist();
            },
            forget: (sessionId) => {
                if (rememberedId === sessionId) {
                    rememberedId = null;
                    if (identityKey !== null) {
                        centralSessionStorage.remove(rememberedSessionEntry(identityKey));
                    }
                }
                set((state) => {
                    const titles = new Map(state.titles);
                    titles.delete(sessionId);
                    return { titles };
                });
            },
            observed: (sessionId, title) => put(sessionId, { kind: "known", title }),
            created: (sessionId, title) => put(sessionId, { kind: "created", title }),
            sessionLoaded: (sessionId, title, startedWith) => {
                const current = get().titles.get(sessionId);
                if (current?.kind === "created" || (current !== undefined && current !== startedWith.get(sessionId))) {
                    return;
                }
                put(sessionId, { kind: "known", title });
            },
            directoryLoaded: (sessions, startedWith) => {
                const titles = new Map(get().titles);
                for (const session of sessions) {
                    const current = titles.get(session.id);
                    // A new Session keeps its first-prompt title until the Runtime confirms it was prompted.
                    if (
                        (current?.kind === "created" && !session.prompted) ||
                        (current !== undefined && current !== startedWith.get(session.id))
                    ) {
                        continue;
                    }
                    titles.set(session.id, { kind: "known", title: session.title });
                }
                set({ titles });
                persist();
            },
        };
    });
}
