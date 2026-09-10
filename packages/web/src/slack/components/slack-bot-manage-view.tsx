import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { type ManagementRequests, useManagementRequests } from "../requests/management";
import { createDashboardStore } from "../store/dashboard-store";
import { IntegrationCard } from "./integration-card";
import { Button } from "./ui/button";

export function SlackBotManageView() {
    const requests = useManagementRequests();
    return <SlackBots requests={requests} canManage />;
}

export function SlackBots({
    requests,
    canManage,
}: {
    readonly requests: ManagementRequests;
    readonly canManage: boolean;
}) {
    const [store] = useState(() => createDashboardStore(requests));
    const management = useStore(store);
    const [draft, setDraft] = useState<{ readonly id: string; readonly name: string } | null>(null);
    const lifetime = useRef(new AbortController());
    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        void management.load(controller.signal);
        return () => controller.abort();
    }, [management.load]);
    const { state } = management;
    return (
        <section
            className="grid gap-6 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-7"
            aria-label="Slack bots"
        >
            <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                    <h2 className="text-xl font-semibold">Slack bots</h2>
                    <p className="mt-1 text-sm text-slate-500">
                        Manage Slack installations and bind them to Mobius bots.
                    </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    <Button
                        variant="outline"
                        type="button"
                        aria-label="Refresh Slack bots"
                        title="Refresh Slack bots"
                        className="whitespace-nowrap"
                        onClick={() => {
                            setDraft(null);
                            void management.load(lifetime.current.signal);
                        }}
                    >
                        <svg
                            aria-hidden="true"
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M20 7v5h-5M4 17v-5h5" />
                            <path d="M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 18 17" />
                        </svg>
                        <span className="hidden sm:inline">Refresh</span>
                    </Button>
                    {canManage ? (
                        <Button
                            size="icon"
                            type="button"
                            aria-label="Add Slack bot"
                            title="Add Slack bot"
                            onClick={() => setDraft({ id: crypto.randomUUID(), name: "New Slack bot" })}
                        >
                            +
                        </Button>
                    ) : null}
                </div>
            </div>
            {draft ? (
                <IntegrationCard
                    requests={requests}
                    canManage={canManage}
                    key={draft.id}
                    slackBotId={draft.id}
                    botName={draft.name}
                    binding={{ kind: "unbound" }}
                    presentation={{
                        kind: "creation",
                        onClose: () => {
                            setDraft(null);
                            void management.load(lifetime.current.signal);
                        },
                        onRegistered: () => {
                            setDraft(null);
                            void management.load(lifetime.current.signal);
                        },
                    }}
                />
            ) : null}
            {state.status === "loading" ? (
                <p role="status">Loading Slack bots…</p>
            ) : state.status === "error" ? (
                <p role="alert">{state.message}</p>
            ) : state.bots.length === 0 ? (
                <p className="rounded-xl bg-slate-50/80 px-5 py-8 text-center text-sm leading-6 text-slate-500">
                    No Slack bots yet. Use + to set up your first bot.
                </p>
            ) : (
                state.bots.map((bot) => (
                    <IntegrationCard
                        requests={requests}
                        canManage={canManage}
                        key={bot.id}
                        slackBotId={bot.id}
                        botName={bot.name}
                        binding={bot.binding}
                    />
                ))
            )}
        </section>
    );
}
