import { Tabs } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { BotBinding as Binding, ManagementRequests } from "../requests/management";
import { createIntegrationCardStore } from "../store/integration-card-store";
import { BotBinding } from "./bot-binding";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Disclosure } from "./ui/disclosure";

export function IntegrationCard({
    slackBotId: botId,
    botName,
    binding,
    requests,
    canManage: owner,
    presentation = { kind: "card" },
}: {
    readonly slackBotId: string;
    readonly botName: string;
    readonly binding: Binding;
    readonly requests: ManagementRequests;
    readonly canManage: boolean;
    readonly presentation?:
        | { readonly kind: "card" }
        | { readonly kind: "creation"; readonly onClose: () => void; readonly onRegistered: () => void };
}) {
    const [store] = useState(() =>
        createIntegrationCardStore(botId, requests, presentation.kind === "creation" ? "new" : "existing"),
    );
    const management = useStore(store);
    const { state } = management;
    const controller = useRef(new AbortController());
    const initiallyOpen = presentation.kind === "creation";
    const closeSetup = () => {
        if (presentation.kind === "creation") {
            presentation.onClose();
        } else {
            management.closeSetup();
        }
    };
    useEffect(() => {
        const lifetime = new AbortController();
        controller.current = lifetime;
        if (!initiallyOpen) {
            void management.load(lifetime.signal);
        }
        return () => lifetime.abort();
    }, [management.load, initiallyOpen]);
    const connection = "connection" in state ? state.connection : null;
    const openOAuth = (loadDestination: () => Promise<string | null>): void => {
        const popup = window.open("about:blank", "mobius-slack-oauth", "popup,width=720,height=860");
        if (popup === null) {
            return;
        }
        popup.opener = null;
        void loadDestination().then((destination) => {
            if (destination === null) {
                popup.close();
                return;
            }
            popup.location.assign(destination);
            popup.focus();
            if (presentation.kind === "creation") {
                presentation.onRegistered();
            }
        });
    };
    return (
        <>
            {presentation.kind === "card" ? (
                <article
                    aria-label={botName}
                    className="flex items-center justify-between gap-7 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm max-md:flex-col max-md:items-start"
                >
                    <div>
                        <p className="m-0 text-xs font-bold tracking-widest text-primary uppercase">Slack bot</p>
                        <h2 className="my-2 text-xl font-semibold tracking-tight">{botName}</h2>
                        {connection?.kind === "connected" ? (
                            <p>Connected to {connection.slackTeamName ?? connection.slackTeamId}</p>
                        ) : (
                            <p className="m-0 leading-6 text-zinc-500">Install this bot in your Slack workspace.</p>
                        )}
                        {state.status === "error" ? <p role="alert">{state.message}</p> : null}
                        {connection && connection.kind !== "not-configured" ? (
                            <BotBinding requests={requests} canManage={owner} slackBotId={botId} binding={binding} />
                        ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-3 max-md:flex-col max-md:items-start">
                        <span className="rounded-full bg-zinc-100 px-2.5 py-1.5 text-xs font-bold text-zinc-600">
                            {state.status === "loading"
                                ? "Loading…"
                                : state.status === "submitting"
                                  ? "Saving…"
                                  : connection?.kind.replaceAll("-", " ")}
                        </span>
                        {state.status === "error" ? (
                            <Button
                                variant="outline"
                                type="button"
                                onClick={() => {
                                    void management.load(controller.current.signal);
                                }}
                            >
                                Retry
                            </Button>
                        ) : null}
                        {state.status === "summary" ? (
                            <>
                                <Button onClick={management.openSetup} type="button">
                                    {connection?.kind === "connected" ? "Manage Slack" : "Connect Slack"}
                                </Button>
                                {connection?.kind === "connected" ? (
                                    <Button
                                        variant="outline"
                                        type="button"
                                        onClick={() => {
                                            void management.disconnect(controller.current.signal);
                                        }}
                                    >
                                        Disconnect
                                    </Button>
                                ) : null}
                            </>
                        ) : null}
                    </div>
                </article>
            ) : null}
            {state.status === "setup" ? (
                <Dialog
                    title={presentation.kind === "creation" ? "Add Slack bot" : `Connect ${botName}`}
                    description="Connect through Slack OAuth. Create an app with a configuration refresh token, or register an existing app manually."
                    onClose={closeSetup}
                >
                    <div>
                        <Tabs.Root defaultValue="oauth">
                            <Tabs.List
                                aria-label="Slack setup method"
                                className="mb-5 flex gap-1 rounded-lg bg-accent p-1"
                            >
                                {(["oauth", "manual"] as const).map((method) => (
                                    <Tabs.Trigger
                                        key={method}
                                        type="button"
                                        value={method}
                                        className="flex-1 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-xs"
                                    >
                                        {method === "oauth" ? "OAuth" : "Manual Configure"}
                                    </Tabs.Trigger>
                                ))}
                            </Tabs.List>
                            <Tabs.Content value="oauth" className="outline-none">
                                <form
                                    className="grid w-full gap-4"
                                    onSubmit={(event) => {
                                        event.preventDefault();
                                        const values = new FormData(event.currentTarget);
                                        const name = values.get("automaticName");
                                        const refreshToken = values.get("refreshToken");
                                        if (typeof name === "string" && typeof refreshToken === "string") {
                                            openOAuth(() =>
                                                management.connectAutomatically(
                                                    name.trim(),
                                                    refreshToken.trim(),
                                                    controller.current.signal,
                                                ),
                                            );
                                        }
                                    }}
                                >
                                    <h3 className="m-0 text-sm font-medium">Automatic setup</h3>
                                    <p className="m-0 text-sm text-zinc-600">
                                        Mobius creates the app from its manifest, then opens Slack authorization in a
                                        separate window.
                                    </p>
                                    <label className="grid gap-2 text-sm font-semibold">
                                        Slack bot name
                                        <input
                                            name="automaticName"
                                            defaultValue={botName}
                                            required
                                            maxLength={35}
                                            className="h-12 w-full rounded-lg border border-zinc-300 bg-white px-3.5"
                                        />
                                    </label>
                                    <label className="grid gap-2 text-sm font-semibold">
                                        Slack app configuration refresh token
                                        <input
                                            autoComplete="off"
                                            className="h-12 w-full rounded-lg border border-border bg-white px-3.5 focus:border-ring focus:outline-2 focus:outline-ring/30"
                                            name="refreshToken"
                                            required
                                            type="password"
                                        />
                                    </label>
                                    <Button type="submit">Create app and continue with Slack</Button>
                                </form>
                            </Tabs.Content>
                            <Tabs.Content value="manual" className="grid gap-4 outline-none">
                                <Button
                                    variant="outline"
                                    type="button"
                                    onClick={() => {
                                        void management.manifest(botName, controller.current.signal);
                                    }}
                                >
                                    Show Slack app manifest
                                </Button>
                                {state.manifest !== null ? (
                                    <Disclosure defaultOpen label="Copy this JSON into Slack’s “From a manifest” setup">
                                        <textarea
                                            aria-label="Slack app manifest"
                                            readOnly
                                            rows={7}
                                            value={state.manifest}
                                        />
                                    </Disclosure>
                                ) : null}
                                {state.connection.kind !== "not-configured" ? (
                                    <Button
                                        type="button"
                                        onClick={() => {
                                            openOAuth(() => management.connect(null, controller.current.signal));
                                        }}
                                    >
                                        Continue with registered Slack app
                                    </Button>
                                ) : null}
                                <form
                                    className="grid w-full gap-4"
                                    onSubmit={(event) => {
                                        event.preventDefault();
                                        const values = Object.fromEntries(new FormData(event.currentTarget));
                                        openOAuth(() => management.connect(values, controller.current.signal));
                                    }}
                                >
                                    <label className="grid gap-2 text-sm font-semibold">
                                        App name
                                        <input
                                            className="h-12 w-full rounded-lg border border-border bg-white px-3.5 focus:border-ring focus:outline-2 focus:outline-ring/30"
                                            name="name"
                                            defaultValue={botName}
                                            required
                                        />
                                    </label>
                                    <label className="grid gap-2 text-sm font-semibold">
                                        Slack App ID
                                        <input
                                            className="h-12 w-full rounded-lg border border-border bg-white px-3.5 focus:border-ring focus:outline-2 focus:outline-ring/30"
                                            name="slackAppId"
                                            placeholder="A…"
                                            required
                                        />
                                    </label>
                                    <label className="grid gap-2 text-sm font-semibold">
                                        Client ID
                                        <input
                                            className="h-12 w-full rounded-lg border border-border bg-white px-3.5 focus:border-ring focus:outline-2 focus:outline-ring/30"
                                            name="clientId"
                                            required
                                        />
                                    </label>
                                    <label className="grid gap-2 text-sm font-semibold">
                                        Client secret
                                        <input
                                            className="h-12 w-full rounded-lg border border-border bg-white px-3.5 focus:border-ring focus:outline-2 focus:outline-ring/30"
                                            name="clientSecret"
                                            type="password"
                                            autoComplete="off"
                                            required
                                        />
                                    </label>
                                    <label className="grid gap-2 text-sm font-semibold">
                                        Signing secret
                                        <input
                                            className="h-12 w-full rounded-lg border border-border bg-white px-3.5 focus:border-ring focus:outline-2 focus:outline-ring/30"
                                            name="signingSecret"
                                            type="password"
                                            autoComplete="off"
                                            required
                                        />
                                    </label>
                                    <div className="mt-7 flex items-center justify-end gap-3">
                                        <Button type="submit">Save and continue with Slack</Button>
                                    </div>
                                </form>
                            </Tabs.Content>
                        </Tabs.Root>
                        {state.error !== null ? <p role="alert">{state.error}</p> : null}
                        <div className="mt-5 flex justify-end border-t border-border pt-4">
                            <Button variant="outline" onClick={closeSetup} type="button">
                                Close
                            </Button>
                        </div>
                    </div>
                </Dialog>
            ) : null}
        </>
    );
}
