import { useOutletContext } from "react-router";
import type { BotDetailContext } from "@/components/bots/bot-workspace";

export function BotConnectionsPage() {
    const { bot } = useOutletContext<BotDetailContext>();
    return (
        <div className="mx-auto max-w-3xl p-5 sm:p-8">
            <section className="rounded-2xl border border-black/10 bg-white p-6">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Connections</p>
                <h2 className="mt-2 text-xl font-semibold">Slack bindings</h2>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                    Slack apps bind directly to the Chat-owned Bot ID{" "}
                    <span className="font-mono text-xs">{bot.botId}</span>. Connection grants, owner credentials, and
                    Mobius Bot delivery targets are no longer used.
                </p>
            </section>
        </div>
    );
}
