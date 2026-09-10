import { useEffect, useRef, useState } from "react";
import { type BotBinding as Binding, type ManagementRequests, managementError } from "../requests/management";
import { Button } from "./ui/button";
import { Disclosure } from "./ui/disclosure";
import { Select } from "./ui/select";

type BotOption = { readonly projectId: string; readonly botId: string; readonly displayName: string };
type FormState =
    | { readonly kind: "ready" }
    | { readonly kind: "saving" }
    | { readonly kind: "error"; readonly message: string };
type OptionsState =
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly bots: readonly BotOption[] }
    | { readonly kind: "error"; readonly message: string };

export function BotBinding({
    slackBotId,
    binding: initial,
    requests,
    canManage,
}: {
    readonly slackBotId: string;
    readonly binding: Binding;
    readonly requests: ManagementRequests;
    readonly canManage: boolean;
}) {
    const [binding, setBinding] = useState(initial);
    const [state, setState] = useState<FormState>({ kind: "ready" });
    const [options, setOptions] = useState<OptionsState>({ kind: "loading" });
    const lifetime = useRef(new AbortController());
    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        return () => controller.abort();
    }, []);
    const loadBots = () => {
        const signal = lifetime.current.signal;
        setOptions({ kind: "loading" });
        void requests
            .listBindableBots(signal)
            .then((bots) => {
                if (!signal.aborted) {
                    setOptions({ kind: "ready", bots });
                }
            })
            .catch((error) => {
                if (!signal.aborted) {
                    setOptions({ kind: "error", message: managementError(error) });
                }
            });
    };
    return (
        <div className="grid gap-2">
            <p role="status" className="break-all text-xs leading-5 text-muted-foreground">
                {binding.kind === "bound" ? `Mobius bot: ${binding.botId}` : "Mobius bot: Unbound"}
            </p>
            {canManage ? (
                <Disclosure
                    label={binding.kind === "bound" ? "Change Mobius bot" : "Bind Mobius bot"}
                    onOpenChange={(open) => {
                        if (open) {
                            loadBots();
                        }
                    }}
                >
                    <p className="my-2 text-sm text-muted-foreground">
                        Select a bot from a project authorized in this browser.
                    </p>
                    {options.kind === "loading" ? (
                        <p role="status">Loading available bots…</p>
                    ) : options.kind === "error" ? (
                        <p role="alert">{options.message}</p>
                    ) : options.bots.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            Pair or connect a project in Mobius bots above, then add a bot.
                        </p>
                    ) : (
                        <form
                            className="grid gap-3"
                            onSubmit={(event) => {
                                event.preventDefault();
                                const botId = new FormData(event.currentTarget).get("botId");
                                const bot = options.bots.find((candidate) => candidate.botId === botId);
                                if (bot === undefined) {
                                    return;
                                }
                                const signal = lifetime.current.signal;
                                setState({ kind: "saving" });
                                void requests
                                    .bindBot(slackBotId, { botId: bot.botId, projectId: bot.projectId }, signal)
                                    .then((result) => {
                                        if (!signal.aborted) {
                                            setBinding(result);
                                            setState({ kind: "ready" });
                                        }
                                    })
                                    .catch((error) => {
                                        if (!signal.aborted) {
                                            setState({ kind: "error", message: managementError(error) });
                                        }
                                    });
                            }}
                        >
                            <div className="grid gap-2 text-xs font-medium">
                                Mobius bot
                                <Select
                                    label="Mobius bot"
                                    name="botId"
                                    required
                                    placeholder="Select a Mobius bot"
                                    options={options.bots.map((bot) => ({ value: bot.botId, label: bot.displayName }))}
                                />
                            </div>
                            <Button type="submit" disabled={state.kind === "saving"}>
                                {state.kind === "saving" ? "Binding…" : "Save binding"}
                            </Button>
                            {state.kind === "error" ? <p role="alert">{state.message}</p> : null}
                        </form>
                    )}
                    <Button variant="ghost" size="sm" className="mt-2" onClick={loadBots}>
                        Refresh available bots
                    </Button>
                </Disclosure>
            ) : null}
        </div>
    );
}
