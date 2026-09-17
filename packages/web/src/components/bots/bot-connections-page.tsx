import { Check, Copy, LoaderCircle, Plug, RefreshCw, ShieldCheck, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useOutletContext } from "react-router";
import { useStore } from "zustand";
import { BOT_FIELD_CLASS, BotInlineError } from "@/components/bots/bot-page-header";
import type { BotDetailContext } from "@/components/bots/bot-workspace";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
    CONNECTOR_SCOPES,
    createBotConnectionsStore,
    formatConnectionDate,
    targetsForConnection,
} from "@/view-models/bots/connections-store";

export function BotConnectionsPage() {
    const { bot, client, signal } = useOutletContext<BotDetailContext>();
    const [store] = useState(() => createBotConnectionsStore(bot.botId, client));
    const viewModel = useStore(store);
    const {
        busyResourceId,
        copyAnnouncement,
        directory: state,
        grant: grantState,
        grantForm,
        operationError,
        revokeConfirmationId,
    } = viewModel;
    const grantFormOpen = grantForm.kind === "editing";

    useEffect(() => {
        void viewModel.loadConnections(signal);
    }, [signal, viewModel.loadConnections]);

    const ready = state.kind === "ready" ? state.directory : undefined;
    return (
        <div className="mx-auto w-full max-w-[920px] px-5 py-7 sm:px-8 sm:py-9">
            <section aria-labelledby="bot-connections-heading">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                    <div className="max-w-2xl">
                        <p className="text-[11px] font-semibold tracking-[0.08em] text-[#218854] uppercase">
                            Provider-neutral access
                        </p>
                        <h2 className="mt-2 text-xl font-semibold tracking-[-0.025em]" id="bot-connections-heading">
                            Connections
                        </h2>
                        <p className="mt-1 text-sm leading-6 text-muted-foreground">
                            Create a short-lived one-time grant for an external connector. Provider credentials and real
                            destination identifiers never enter Mobius or the local Agent.
                        </p>
                    </div>
                    {!grantFormOpen && (
                        <Button
                            className="min-h-11 shrink-0"
                            disabled={bot.state.kind === "archived"}
                            onClick={viewModel.openGrantForm}
                        >
                            <Plug aria-hidden="true" className="size-4" /> Create connection grant
                        </Button>
                    )}
                </div>

                {grantFormOpen && (
                    <form
                        className="mt-5 rounded-2xl border-[0.5px] border-black/10 bg-white p-5 shadow-[0_1px_4px_rgba(0,0,0,0.035)]"
                        onSubmit={(event) => {
                            event.preventDefault();
                            void viewModel.createGrant(signal);
                        }}
                    >
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <h3 className="text-sm font-semibold">One-time connector grant</h3>
                                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                    Valid for 10 minutes and consumed atomically once.
                                </p>
                            </div>
                            <Button
                                aria-label="Close connection grant form"
                                className="size-11 sm:size-9"
                                disabled={grantState.kind === "creating"}
                                onClick={viewModel.closeGrantForm}
                                size="icon"
                                type="button"
                                variant="ghost"
                            >
                                <X aria-hidden="true" className="size-4" />
                            </Button>
                        </div>
                        <div className="mt-4 grid gap-4 sm:grid-cols-2">
                            <label className="grid gap-1.5 text-xs font-semibold" htmlFor="bot-connector-audience">
                                Connector audience
                                <input
                                    className={BOT_FIELD_CLASS}
                                    disabled={grantState.kind === "creating"}
                                    id="bot-connector-audience"
                                    onChange={(event) => viewModel.setAudience(event.target.value)}
                                    value={grantForm.kind === "editing" ? grantForm.audience : ""}
                                />
                            </label>
                            <label className="grid gap-1.5 text-xs font-semibold" htmlFor="bot-connection-label">
                                Connection label
                                <input
                                    className={BOT_FIELD_CLASS}
                                    disabled={grantState.kind === "creating"}
                                    id="bot-connection-label"
                                    maxLength={200}
                                    onChange={(event) => viewModel.setLabel(event.target.value)}
                                    placeholder="Production connector"
                                    value={grantForm.kind === "editing" ? grantForm.label : ""}
                                />
                            </label>
                        </div>
                        <fieldset className="mt-4 rounded-xl border-[0.5px] border-black/8 bg-black/[0.018] p-3">
                            <legend className="px-1 text-xs font-semibold">Granted scopes</legend>
                            <ul className="mt-1 grid gap-1 sm:grid-cols-2">
                                {CONNECTOR_SCOPES.map((scope) => (
                                    <li
                                        className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground"
                                        key={scope}
                                    >
                                        <Check aria-hidden="true" className="size-3 text-[#218854]" /> {scope}
                                    </li>
                                ))}
                            </ul>
                        </fieldset>
                        {grantState.kind === "failed" && <BotInlineError>{grantState.message}</BotInlineError>}
                        {grantState.kind === "ready" && (
                            <div className="mt-4 rounded-xl border border-[#9bd8b7] bg-[#f4fcf7] p-4">
                                <div className="flex items-start justify-between gap-3">
                                    <span>
                                        <strong className="block text-sm font-semibold">Copy this grant now</strong>
                                        <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                                            The secret is displayed once and expires{" "}
                                            {formatConnectionDate(grantState.grant.expiresAt)}.
                                        </span>
                                    </span>
                                    <Button
                                        aria-label="Copy connection grant"
                                        className="size-11 shrink-0 sm:size-9"
                                        onClick={() => void viewModel.copyGrant()}
                                        size="icon"
                                        type="button"
                                        variant="outline"
                                    >
                                        <Copy aria-hidden="true" className="size-4" />
                                    </Button>
                                </div>
                                <dl className="mt-3 grid gap-2 text-xs">
                                    <div>
                                        <dt className="font-semibold">Grant ID</dt>
                                        <dd className="mt-1 break-all rounded-lg bg-white p-2 font-mono">
                                            {grantState.grant.grantId}
                                        </dd>
                                    </div>
                                    <div>
                                        <dt className="font-semibold">Grant secret</dt>
                                        <dd className="mt-1 break-all rounded-lg bg-white p-2 font-mono">
                                            {grantState.grant.grantSecret}
                                        </dd>
                                    </div>
                                </dl>
                                <p aria-live="polite" className="mt-2 text-xs text-[#187747]">
                                    {copyAnnouncement}
                                </p>
                            </div>
                        )}
                        <div className="mt-4">
                            <Button
                                aria-busy={grantState.kind === "creating"}
                                className="min-h-11"
                                disabled={grantState.kind === "creating" || grantState.kind === "ready"}
                                type="submit"
                            >
                                {grantState.kind === "creating" ? (
                                    <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                                ) : (
                                    <ShieldCheck aria-hidden="true" className="size-4" />
                                )}
                                Create grant
                            </Button>
                        </div>
                    </form>
                )}
            </section>

            <section aria-labelledby="connected-services-heading" className="mt-9">
                <div className="flex items-center justify-between gap-3">
                    <h2 className="text-base font-semibold" id="connected-services-heading">
                        Connected services
                    </h2>
                    <Button
                        aria-label="Refresh connections"
                        className="size-11 sm:size-9"
                        onClick={() => void viewModel.loadConnections(signal)}
                        size="icon"
                        variant="ghost"
                    >
                        <RefreshCw aria-hidden="true" className="size-4" />
                    </Button>
                </div>
                {operationError.length > 0 && <BotInlineError>{operationError}</BotInlineError>}
                {state.kind === "loading" && (
                    <div
                        aria-busy="true"
                        className="mt-3 flex min-h-24 items-center gap-3 rounded-xl border-[0.5px] border-black/10 bg-white px-5 text-sm text-muted-foreground"
                    >
                        <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> Loading connections…
                    </div>
                )}
                {state.kind === "failed" && (
                    <div className="mt-3 rounded-xl border border-[#f2c4c4] bg-[#fff7f7] p-4">
                        <BotInlineError>{state.message}</BotInlineError>
                        <Button
                            className="mt-3 min-h-11"
                            onClick={() => void viewModel.loadConnections(signal)}
                            variant="outline"
                        >
                            Retry
                        </Button>
                    </div>
                )}
                {ready !== undefined && ready.connections.length === 0 && (
                    <div className="mt-3 rounded-2xl border border-dashed border-black/15 bg-white/60 px-6 py-9 text-center">
                        <Plug aria-hidden="true" className="mx-auto size-6 text-[#218854]" />
                        <p className="mt-3 text-sm font-semibold">No connector has redeemed a grant</p>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            Create a grant above, then give its one-time credentials to the connector you trust.
                        </p>
                    </div>
                )}
                {ready !== undefined && ready.connections.length > 0 && (
                    <ul aria-label="Bot connections" className="mt-3 grid gap-3">
                        {ready.connections.map((connection) => {
                            const targets = targetsForConnection(ready, connection.connectionId);
                            const confirming = revokeConfirmationId === connection.connectionId;
                            return (
                                <li
                                    className="rounded-2xl border-[0.5px] border-black/10 bg-white p-5 shadow-[0_1px_4px_rgba(0,0,0,0.035)]"
                                    key={connection.connectionId}
                                >
                                    <div className="flex flex-wrap items-start justify-between gap-3">
                                        <span className="min-w-0">
                                            <span className="flex flex-wrap items-center gap-2">
                                                <strong className="text-sm font-semibold">{connection.label}</strong>
                                                <span
                                                    className={cn(
                                                        "rounded-full px-2 py-1 text-[10px] font-semibold",
                                                        connection.state.kind === "active"
                                                            ? "bg-[#e8f8ef] text-[#187747]"
                                                            : "bg-[#fff0f0] text-[#9b2c32]",
                                                    )}
                                                >
                                                    {connection.state.kind === "active" ? "Active" : "Revoked"}
                                                </span>
                                            </span>
                                            <span className="mt-1 block text-[11px] text-muted-foreground">
                                                {connection.audience} · {connection.connectorPrincipalId}
                                            </span>
                                        </span>
                                        {connection.state.kind === "active" && !confirming && (
                                            <Button
                                                className="min-h-11 text-[#9b2c32] hover:text-[#9b2c32]"
                                                onClick={() => viewModel.confirmRevocation(connection.connectionId)}
                                                variant="ghost"
                                            >
                                                <Trash2 aria-hidden="true" className="size-4" /> Revoke
                                            </Button>
                                        )}
                                    </div>
                                    {confirming && (
                                        <div className="mt-4 rounded-xl border border-[#f2c4c4] bg-[#fff7f7] p-3">
                                            <p className="text-xs leading-5 text-[#7f2429]">
                                                Revoking stops this connector and disables all of its delivery targets.
                                                Other connections are unaffected.
                                            </p>
                                            <div className="mt-3 flex flex-wrap gap-2">
                                                <Button
                                                    className="min-h-11 bg-[#8f252b] text-white hover:bg-[#781f24]"
                                                    disabled={busyResourceId === connection.connectionId}
                                                    onClick={() => void viewModel.revokeConnection(connection, signal)}
                                                >
                                                    {busyResourceId === connection.connectionId ? (
                                                        <LoaderCircle
                                                            aria-hidden="true"
                                                            className="size-4 animate-spin"
                                                        />
                                                    ) : (
                                                        <Trash2 aria-hidden="true" className="size-4" />
                                                    )}
                                                    Confirm revoke
                                                </Button>
                                                <Button
                                                    className="min-h-11"
                                                    onClick={() => viewModel.confirmRevocation("")}
                                                    variant="ghost"
                                                >
                                                    Cancel
                                                </Button>
                                            </div>
                                        </div>
                                    )}
                                    <div className="mt-4 border-t-[0.5px] border-black/8 pt-4">
                                        <div className="flex items-center justify-between gap-3">
                                            <h3 className="text-xs font-semibold">Delivery targets</h3>
                                            <span className="text-[10px] text-muted-foreground">{targets.length}</span>
                                        </div>
                                        {targets.length === 0 ? (
                                            <p className="mt-2 text-xs leading-5 text-muted-foreground">
                                                The connector has not registered an opaque delivery target yet.
                                            </p>
                                        ) : (
                                            <ul className="mt-2 grid gap-2">
                                                {targets.map((target) => (
                                                    <li
                                                        className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-black/[0.025] px-3 py-2"
                                                        key={target.deliveryTargetId}
                                                    >
                                                        <span>
                                                            <strong className="block text-xs font-medium">
                                                                {target.alias}
                                                            </strong>
                                                            <span className="mt-0.5 block font-mono text-[9px] text-muted-foreground">
                                                                {target.deliveryTargetId}
                                                            </span>
                                                        </span>
                                                        {target.state.kind === "active" && !target.ownerApproved ? (
                                                            <Button
                                                                className="min-h-11 sm:min-h-9"
                                                                disabled={busyResourceId === target.deliveryTargetId}
                                                                onClick={() =>
                                                                    void viewModel.approveTarget(
                                                                        target.deliveryTargetId,
                                                                        target.outboundPolicyRevision,
                                                                        signal,
                                                                    )
                                                                }
                                                                variant="outline"
                                                            >
                                                                {busyResourceId === target.deliveryTargetId ? (
                                                                    <LoaderCircle
                                                                        aria-hidden="true"
                                                                        className="size-4 animate-spin"
                                                                    />
                                                                ) : (
                                                                    <ShieldCheck
                                                                        aria-hidden="true"
                                                                        className="size-4"
                                                                    />
                                                                )}
                                                                Approve target
                                                            </Button>
                                                        ) : (
                                                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-muted-foreground">
                                                                {target.ownerApproved &&
                                                                    target.state.kind === "active" && (
                                                                        <Check
                                                                            aria-hidden="true"
                                                                            className="size-3 text-[#218854]"
                                                                        />
                                                                    )}
                                                                {target.state.kind === "disabled"
                                                                    ? "Disabled"
                                                                    : target.ownerApproved
                                                                      ? "Approved"
                                                                      : "Not approved"}
                                                            </span>
                                                        )}
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </section>
        </div>
    );
}
