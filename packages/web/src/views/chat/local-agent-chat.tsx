import { useRouter, useRouterState } from "@tanstack/react-router";
import { History, LoaderCircle, Plus, Send, StopCircle } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../components/ui/cloud-button.tsx";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import type { ManagedBot } from "../../services/management/management-api.ts";
import { LocalAgentInteractions } from "./local-agent-interactions.tsx";
import { LocalAgentSessionsDialog } from "./local-agent-sessions-dialog.tsx";
import { LocalAgentTranscript } from "./local-agent-transcript.tsx";
import { useLocalAgentChat } from "./use-local-agent-chat.ts";

export function LocalAgentChat({
    bot,
    bots,
    onSelectBot,
    botActions,
    requests,
}: {
    readonly bot: ManagedBot;
    readonly bots: readonly ManagedBot[];
    readonly onSelectBot: (botId: string) => void;
    readonly botActions: ReactNode;
    readonly requests: Pick<
        BotChatApi,
        "localRuntime" | "localSessions" | "createLocalSession" | "connectLocalRuntime" | "agentSettings"
    >;
}) {
    const router = useRouter();
    const routeSessionId = useRouterState({
        select: (state) => {
            const value = Reflect.get(state.location.search, "sessionId");
            return typeof value === "string" ? value : null;
        },
    });
    const selectRouteSession = (sessionId: string) => {
        void router.navigate({
            to: "/chat",
            search: { ...router.state.location.search, sessionId },
            replace: true,
        });
    };
    const {
        runtime,
        sessions,
        selectedId,
        titles,
        messages,
        history,
        loadMore,
        historyError,
        draft,
        setDraft,
        selectedModel,
        setSelectedModel,
        turn,
        setTurn,
        interaction,
        elicitationValues,
        setElicitationValues,
        nativeEntries,
        setNativeEntries,
        open,
        newChat,
        send,
        browse,
        importSession,
        readImage,
        answerPermission,
        answerElicitation,
    } = useLocalAgentChat({ bot, requests, routeSessionId, selectRouteSession });
    return (
        <main aria-label="Chat" className="fixed inset-0 flex min-h-0 bg-background text-foreground">
            <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-card p-3 max-sm:w-44">
                <label className="text-xs text-muted-foreground" htmlFor="local-bot-choice">
                    Bot
                </label>
                <select
                    className="mt-1 rounded-lg border border-border bg-background p-2 text-sm"
                    id="local-bot-choice"
                    onChange={(event) => onSelectBot(event.target.value)}
                    value={bot.botId}
                >
                    {bots.map((item) => (
                        <option key={item.botId} value={item.botId}>
                            {item.displayName}
                        </option>
                    ))}
                </select>
                <Button className="mt-4 justify-start gap-2" onClick={() => void newChat()} variant="outline">
                    <Plus className="size-4" /> New conversation
                </Button>
                <Button className="mt-2 justify-start gap-2" onClick={() => void browse()} variant="outline">
                    <History className="size-4" /> Local Agent sessions
                </Button>
                <nav aria-label="Conversations" className="mt-4 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
                    {sessions.map((session) => (
                        <button
                            aria-current={selectedId === session.id ? "page" : undefined}
                            className="min-h-10 rounded-lg px-2 text-left text-sm hover:bg-muted aria-[current=page]:bg-muted"
                            key={session.id}
                            onClick={() => void open(session)}
                            type="button"
                        >
                            {titles.get(session.id) ?? session.title}
                        </button>
                    ))}
                </nav>
                <div className="mt-3 space-y-2 border-t border-border pt-3">{botActions}</div>
            </aside>
            <section className="flex min-w-0 flex-1 flex-col">
                <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4 text-sm font-medium">
                    <span>{bot.displayName}</span>
                    {runtime.kind === "ready" && runtime.models.length > 0 && (
                        <select
                            aria-label="Model"
                            className="rounded-lg border border-border bg-background p-2 text-sm"
                            onChange={(event) => setSelectedModel(event.target.value)}
                            value={selectedModel}
                        >
                            {runtime.models.map((model) => (
                                <option key={model.value} value={model.value}>
                                    {model.name}
                                </option>
                            ))}
                        </select>
                    )}
                </header>
                {runtime.kind === "connecting" && (
                    <p className="m-auto flex items-center gap-2" role="status">
                        <LoaderCircle className="size-4 animate-spin" /> Connecting to Agent…
                    </p>
                )}
                {runtime.kind === "failed" && (
                    <p className="m-auto" role="alert">
                        {runtime.message}
                    </p>
                )}
                {runtime.kind === "ready" && (
                    <>
                        <LocalAgentTranscript
                            messages={messages}
                            history={history}
                            loadMore={loadMore}
                            turn={turn}
                            historyError={historyError}
                            readImage={readImage}
                        >
                            <LocalAgentInteractions
                                interaction={interaction}
                                elicitationValues={elicitationValues}
                                setElicitationValues={setElicitationValues}
                                answerPermission={answerPermission}
                                answerElicitation={answerElicitation}
                            />
                        </LocalAgentTranscript>
                        <form
                            className="border-t border-border p-4"
                            onSubmit={(event) => {
                                event.preventDefault();
                                void send();
                            }}
                        >
                            <div className="mx-auto flex max-w-3xl gap-2">
                                <textarea
                                    aria-label="Message"
                                    className="min-h-14 flex-1 resize-y rounded-xl border border-border bg-card p-3 text-sm"
                                    onChange={(event) => setDraft(event.target.value)}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter" && !event.shiftKey) {
                                            event.preventDefault();
                                            void send();
                                        }
                                    }}
                                    placeholder="Ask Agent…"
                                    value={draft}
                                />
                                {turn.kind === "running" ? (
                                    <Button
                                        aria-label="Cancel turn"
                                        onClick={() => {
                                            runtime.client.cancel({
                                                commandId: turn.commandId,
                                                sessionId: turn.sessionId,
                                            });
                                            setTurn({
                                                kind: "unknown",
                                                prompt: turn.prompt,
                                                message:
                                                    "Cancellation requested. Check local history before sending again.",
                                            });
                                        }}
                                        type="button"
                                    >
                                        <StopCircle className="size-4" />
                                    </Button>
                                ) : (
                                    <Button
                                        aria-label="Send message"
                                        disabled={
                                            !runtime.online ||
                                            (history.kind !== "ready" && history.kind !== "none") ||
                                            draft.trim().length === 0
                                        }
                                        type="submit"
                                    >
                                        <Send className="size-4" />
                                    </Button>
                                )}
                            </div>
                        </form>
                    </>
                )}
            </section>
            <LocalAgentSessionsDialog
                entries={nativeEntries}
                onClose={() => setNativeEntries(null)}
                onImport={importSession}
            />
        </main>
    );
}
