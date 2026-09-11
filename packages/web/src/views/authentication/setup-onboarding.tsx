import { ArrowUpRight, Check, Copy, Laptop, MessageSquare, Terminal } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/cloud-button.tsx";

export function SetupOnboarding() {
    const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
    const instruction = `follow ${window.location.origin}/SKILL.md`;
    return (
        <main className="flex min-h-dvh flex-col bg-background text-foreground">
            <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-7">
                <span className="flex items-center gap-2.5 text-sm font-semibold tracking-tight">
                    <MessageSquare className="size-5 text-primary" aria-hidden="true" /> Mobius Chat
                </span>
                <Button asChild variant="ghost">
                    <a href="/login">
                        Sign in <ArrowUpRight className="size-4" />
                    </a>
                </Button>
            </div>
            <section className="mx-auto grid w-full max-w-3xl flex-1 animate-cloud-enter content-center gap-8 px-6 py-12 motion-reduce:animate-none sm:py-20">
                <div className="space-y-5">
                    <span className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
                        <Laptop className="size-3.5" aria-hidden="true" /> Your agent. Your machine.
                    </span>
                    <h1 className="max-w-2xl text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
                        Your local agent,
                        <br />a conversation away.
                    </h1>
                    <p className="max-w-xl text-base leading-7 text-muted-foreground">
                        Connect the AI agent you already use to a quiet place for your conversations. Start on your
                        machine, then pick up here.
                    </p>
                </div>
                <div className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
                    <label htmlFor="setup-instruction" className="mb-3 flex items-center gap-2 text-sm font-medium">
                        <Terminal className="size-4 text-primary" aria-hidden="true" /> Paste this into your local agent
                    </label>
                    <div className="flex flex-col gap-3 sm:flex-row">
                        <input
                            id="setup-instruction"
                            readOnly
                            value={instruction}
                            onFocus={(event) => event.currentTarget.select()}
                            className="min-w-0 flex-1 rounded-lg border border-border bg-muted/30 px-3 py-3 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                        <Button
                            className="min-h-11 px-5"
                            onClick={() => {
                                void navigator.clipboard.writeText(instruction).then(
                                    () => setCopy("copied"),
                                    () => setCopy("failed"),
                                );
                            }}
                        >
                            {copy === "copied" ? <Check className="size-4" /> : <Copy className="size-4" />}
                            {copy === "copied" ? "Copied" : "Copy instruction"}
                        </Button>
                    </div>
                    <p role="status" className="mt-3 text-xs leading-5 text-muted-foreground">
                        {copy === "failed"
                            ? "Select the instruction above and copy it manually."
                            : copy === "copied"
                              ? "Copied. Paste it into your local AI agent to begin."
                              : "No account or global CLI installation needed. Your agent handles setup."}
                    </p>
                </div>
                <ol className="grid gap-6 sm:grid-cols-3">
                    {[
                        ["01", "Copy the instruction", "Use the command above in your local AI agent."],
                        ["02", "Let your agent connect", "It sets up your Bot and pairs this machine."],
                        ["03", "Open your Chat link", "Your agent gives you a one-time link back here."],
                    ].map(([number, title, detail]) => (
                        <li key={number} className="space-y-2">
                            <span className="font-mono text-xs text-primary">{number}</span>
                            <h2 className="text-sm font-medium">{title}</h2>
                            <p className="text-sm leading-6 text-muted-foreground">{detail}</p>
                        </li>
                    ))}
                </ol>
                <p className="text-xs leading-6 text-muted-foreground">
                    Keep the local agent running while you chat. Already connected on another device? Open the handoff
                    link from your agent to restore that workspace.
                </p>
            </section>
        </main>
    );
}
