import { MobiusUnavailableBotBindingState } from "@moxt-ai/mobius-sdk";
import { CheckCircle2, LoaderCircle, Pause, Play, RefreshCw, Save, ShieldCheck, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useOutletContext } from "react-router";
import { useStore } from "zustand";
import { BOT_FIELD_CLASS, BOT_TEXTAREA_CLASS, BotInlineError } from "@/components/bots/bot-page-header";
import type { BotDetailContext } from "@/components/bots/bot-workspace";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { botConnectionsRoutePath } from "@/services/application/app-routes";
import { createBotActivationStore } from "@/view-models/bots/overview-activation-store";
import {
    botBehaviorStatusLabel,
    botBindingStatusLabel,
    createBotConfigurationStore,
    formatBotDate,
} from "@/view-models/bots/overview-configuration-store";
import { createBotLifecycleStore } from "@/view-models/bots/overview-lifecycle-store";
import { createBotProfileStore } from "@/view-models/bots/overview-profile-store";

export function BotOverviewPage() {
    const { bot, client, connection, refreshBot, signal } = useOutletContext<BotDetailContext>();
    const errorSummaryRef = useRef<HTMLDivElement>(null);
    const [configurationStore] = useState(() => createBotConfigurationStore(bot.botId, client, connection));
    const [activationStore] = useState(() =>
        createBotActivationStore(bot, client, connection, configurationStore, refreshBot),
    );
    const [lifecycleStore] = useState(() => createBotLifecycleStore(bot, client, refreshBot));
    const [profileStore] = useState(() => createBotProfileStore(bot, client, refreshBot));
    const activation = useStore(activationStore);
    const configurationViewModel = useStore(configurationStore);
    const lifecycle = useStore(lifecycleStore);
    const profile = useStore(profileStore);
    const {
        agentRef,
        allowedDeliveryTargetIds,
        completionSelection,
        configuration,
        identityOnly,
        instructions,
        refreshing: refreshingConfiguration,
        workspaceRef,
    } = configurationViewModel;
    const requestingActivation = activation.requesting;
    const { archiveConfirmationOpen, changing: changingLifecycle } = lifecycle;
    const { avatarRef, description, displayName, saving: savingProfile } = profile;
    const operationError = activation.error || profile.error || lifecycle.error;
    const announcement = activation.announcement || profile.announcement || lifecycle.announcement;
    const _instructionCapableAgents = connection.agents.filter((agent) => agent.capabilities.embeddedContextPrompt);

    useEffect(() => {
        activation.syncBot(bot);
        lifecycle.syncBot(bot);
        profile.syncBot(bot);
    }, [activation.syncBot, bot, lifecycle.syncBot, profile.syncBot]);

    useEffect(() => {
        void activation.open(signal);
    }, [activation.open, signal]);

    useEffect(() => {
        if (operationError.length > 0) {
            queueMicrotask(() => errorSummaryRef.current?.focus());
        }
    }, [operationError]);

    const ready = configuration.kind === "ready" ? configuration : undefined;
    const configurationLocked = bot.state.kind === "archived";
    const selectedAgent = connection.agents.find((agent) => agent.id === agentRef);
    const selectedAgentSupportsInstructions = selectedAgent?.capabilities.embeddedContextPrompt === true;

    return (
        <div className="mx-auto w-full max-w-[1040px] px-5 py-7 sm:px-8 sm:py-9">
            {operationError.length > 0 && (
                <div
                    className="mb-5 rounded-xl border border-[#f2c4c4] bg-[#fff7f7] px-4 py-3 text-sm text-[#9b2c32] outline-none"
                    ref={errorSummaryRef}
                    role="alert"
                    tabIndex={-1}
                >
                    {operationError}
                </div>
            )}
            <p aria-live="polite" className={cn("mb-5 text-sm text-[#187747]", announcement.length === 0 && "sr-only")}>
                {announcement}
            </p>

            <div className="grid gap-8 xl:grid-cols-[minmax(0,1.25fr)_minmax(300px,0.75fr)]">
                <div className="min-w-0">
                    <section aria-labelledby="bot-profile-heading">
                        <p className="text-[11px] font-semibold tracking-[0.08em] text-[#218854] uppercase">Identity</p>
                        <h2 className="mt-2 text-xl font-semibold tracking-[-0.025em]" id="bot-profile-heading">
                            Profile
                        </h2>
                        <p className="mt-1 text-sm leading-6 text-muted-foreground">
                            Profile revisions change how the Bot is presented without widening its local execution
                            authority.
                        </p>
                        <form
                            className="mt-5 grid gap-4 rounded-2xl border-[0.5px] border-black/10 bg-white p-5 shadow-[0_1px_4px_rgba(0,0,0,0.035)]"
                            onSubmit={(event) => {
                                event.preventDefault();
                                void profile.save(signal);
                            }}
                        >
                            <label className="grid gap-1.5 text-xs font-semibold" htmlFor="bot-profile-name">
                                Bot name
                                <input
                                    className={BOT_FIELD_CLASS}
                                    disabled={configurationLocked || savingProfile}
                                    id="bot-profile-name"
                                    maxLength={80}
                                    onChange={(event) => profile.setDisplayName(event.target.value)}
                                    value={displayName}
                                />
                            </label>
                            <label className="grid gap-1.5 text-xs font-semibold" htmlFor="bot-profile-description">
                                Description
                                <textarea
                                    className={BOT_TEXTAREA_CLASS}
                                    disabled={configurationLocked || savingProfile}
                                    id="bot-profile-description"
                                    maxLength={2000}
                                    onChange={(event) => profile.setDescription(event.target.value)}
                                    value={description}
                                />
                            </label>
                            <label className="grid gap-1.5 text-xs font-semibold" htmlFor="bot-profile-avatar">
                                Avatar reference <span className="font-normal text-muted-foreground">Optional</span>
                                <input
                                    className={BOT_FIELD_CLASS}
                                    disabled={configurationLocked || savingProfile}
                                    id="bot-profile-avatar"
                                    maxLength={4096}
                                    onChange={(event) => profile.setAvatarRef(event.target.value)}
                                    value={avatarRef}
                                />
                            </label>
                            <div>
                                <Button
                                    aria-busy={savingProfile}
                                    className="min-h-11"
                                    disabled={configurationLocked || savingProfile}
                                    type="submit"
                                >
                                    {savingProfile ? (
                                        <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                                    ) : (
                                        <Save aria-hidden="true" className="size-4" />
                                    )}
                                    Save profile
                                </Button>
                            </div>
                        </form>
                    </section>

                    <section aria-labelledby="bot-execution-heading" className="mt-10">
                        <p className="text-[11px] font-semibold tracking-[0.08em] text-[#218854] uppercase">
                            Local authority
                        </p>
                        <h2 className="mt-2 text-xl font-semibold tracking-[-0.025em]" id="bot-execution-heading">
                            Behavior and execution
                        </h2>
                        <p className="mt-1 text-sm leading-6 text-muted-foreground">
                            Selecting Activate Bot records the exact registered Agent, workspace, and execution
                            configuration.
                        </p>
                        <Button
                            aria-busy={refreshingConfiguration}
                            className="mt-3 min-h-11"
                            disabled={refreshingConfiguration}
                            onClick={() => void configurationViewModel.load(signal)}
                            variant="ghost"
                        >
                            <RefreshCw
                                aria-hidden="true"
                                className={cn("size-3.5", refreshingConfiguration && "animate-spin")}
                            />
                            Refresh execution
                        </Button>

                        {configuration.kind === "loading" && (
                            <div
                                aria-busy="true"
                                className="mt-5 flex min-h-24 items-center gap-3 rounded-xl border-[0.5px] border-black/10 bg-white px-5 text-sm text-muted-foreground"
                            >
                                <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> Loading execution
                                configuration…
                            </div>
                        )}
                        {configuration.kind === "failed" && (
                            <div className="mt-5 rounded-xl border border-[#f2c4c4] bg-[#fff7f7] p-4">
                                <BotInlineError>{configuration.message}</BotInlineError>
                                <Button
                                    className="mt-3 min-h-11"
                                    onClick={() => void configurationViewModel.load(signal)}
                                    variant="outline"
                                >
                                    <RefreshCw aria-hidden="true" className="size-4" /> Retry
                                </Button>
                            </div>
                        )}
                        {ready !== undefined && (
                            <form
                                className="mt-5 grid gap-4 rounded-2xl border-[0.5px] border-black/10 bg-white p-5 shadow-[0_1px_4px_rgba(0,0,0,0.035)]"
                                onSubmit={(event) => {
                                    event.preventDefault();
                                    void activation.activate(signal);
                                }}
                            >
                                <fieldset className="grid gap-2" disabled={configurationLocked || requestingActivation}>
                                    <legend className="text-xs font-semibold">Behavior mode</legend>
                                    <div className="grid gap-2 sm:grid-cols-2">
                                        <label
                                            className={cn(
                                                "flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border-[0.5px] border-black/10 p-3 text-xs",
                                                !selectedAgentSupportsInstructions &&
                                                    "cursor-not-allowed bg-black/[0.025] opacity-65",
                                            )}
                                        >
                                            <input
                                                checked={!identityOnly}
                                                className="mt-0.5 size-4 accent-[#218854]"
                                                disabled={!selectedAgentSupportsInstructions}
                                                name="bot-behavior-mode"
                                                onChange={() => configurationViewModel.selectIdentityOnly(false)}
                                                type="radio"
                                            />
                                            <span>
                                                <strong className="block font-semibold">Custom instructions</strong>
                                                <span className="mt-1 block leading-5 text-muted-foreground">
                                                    {selectedAgentSupportsInstructions
                                                        ? "Apply trusted Bot instructions to every turn."
                                                        : `${selectedAgent?.label ?? "This Agent"} does not expose trusted embedded context.`}
                                                </span>
                                            </span>
                                        </label>
                                        <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border-[0.5px] border-black/10 p-3 text-xs">
                                            <input
                                                checked={identityOnly}
                                                className="mt-0.5 size-4 accent-[#218854]"
                                                name="bot-behavior-mode"
                                                onChange={() => configurationViewModel.selectIdentityOnly(true)}
                                                type="radio"
                                            />
                                            <span>
                                                <strong className="block font-semibold">Identity only</strong>
                                                <span className="mt-1 block leading-5 text-muted-foreground">
                                                    Keep the Bot identity without injecting behavior instructions.
                                                </span>
                                            </span>
                                        </label>
                                    </div>
                                </fieldset>
                                {!identityOnly && (
                                    <label
                                        className="grid gap-1.5 text-xs font-semibold"
                                        htmlFor="bot-behavior-instructions"
                                    >
                                        Behavior instructions
                                        <textarea
                                            className={`${BOT_TEXTAREA_CLASS} min-h-40`}
                                            disabled={configurationLocked || requestingActivation}
                                            id="bot-behavior-instructions"
                                            maxLength={100000}
                                            onChange={(event) =>
                                                configurationViewModel.setInstructions(event.target.value)
                                            }
                                            placeholder="Describe the stable behavior this Bot should apply to every turn."
                                            value={instructions}
                                        />
                                    </label>
                                )}
                                <div className="grid gap-4 sm:grid-cols-2">
                                    <label className="grid gap-1.5 text-xs font-semibold" htmlFor="bot-local-agent">
                                        Local Agent
                                        <select
                                            className={BOT_FIELD_CLASS}
                                            disabled={configurationLocked || requestingActivation}
                                            id="bot-local-agent"
                                            onChange={(event) => configurationViewModel.selectAgent(event.target.value)}
                                            value={agentRef}
                                        >
                                            {connection.agents.length === 0 && (
                                                <option value="">No available Agent</option>
                                            )}
                                            {connection.agents.map((agent) => (
                                                <option key={agent.id} value={agent.id}>
                                                    {agent.label} · {agent.agentVersion}
                                                    {agent.capabilities.embeddedContextPrompt ? "" : " · Identity only"}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                    <label className="grid gap-1.5 text-xs font-semibold" htmlFor="bot-workspace-ref">
                                        Workspace
                                        <input
                                            className={BOT_FIELD_CLASS}
                                            disabled={configurationLocked || requestingActivation}
                                            id="bot-workspace-ref"
                                            onChange={(event) =>
                                                configurationViewModel.setWorkspaceRef(event.target.value)
                                            }
                                            value={workspaceRef}
                                        />
                                    </label>
                                </div>
                                <fieldset
                                    className="rounded-xl border-[0.5px] border-black/10 p-4"
                                    disabled={configurationLocked || requestingActivation}
                                >
                                    <legend className="px-1 text-xs font-semibold">Approved outbound targets</legend>
                                    {ready.deliveryTargets.length === 0 ? (
                                        <p className="text-xs leading-5 text-muted-foreground">
                                            No approved targets are available. Create a connector grant and approve its
                                            opaque target in{` `}
                                            <Link
                                                className="font-medium text-foreground underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
                                                to={botConnectionsRoutePath(connection.channelId, bot.botId)}
                                            >
                                                Connections
                                            </Link>
                                            .
                                        </p>
                                    ) : (
                                        <ul className="grid gap-2">
                                            {ready.deliveryTargets.map((target) => {
                                                const inputId = `bot-delivery-target-${target.deliveryTargetId}`;
                                                return (
                                                    <li key={target.deliveryTargetId}>
                                                        <label
                                                            className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg bg-black/[0.025] px-3 py-2 text-xs"
                                                            htmlFor={inputId}
                                                        >
                                                            <input
                                                                checked={allowedDeliveryTargetIds.includes(
                                                                    target.deliveryTargetId,
                                                                )}
                                                                className="size-4 accent-[#218854]"
                                                                id={inputId}
                                                                onChange={(event) =>
                                                                    configurationViewModel.selectDeliveryTarget(
                                                                        target.deliveryTargetId,
                                                                        event.target.checked,
                                                                    )
                                                                }
                                                                type="checkbox"
                                                            />
                                                            <span className="min-w-0">
                                                                <strong className="block truncate font-medium">
                                                                    {target.alias}
                                                                </strong>
                                                                <span className="block truncate font-mono text-[9px] text-muted-foreground">
                                                                    {target.deliveryTargetId}
                                                                </span>
                                                            </span>
                                                        </label>
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                    )}
                                </fieldset>
                                <label className="grid gap-1.5 text-xs font-semibold" htmlFor="bot-completion-target">
                                    Completion delivery
                                    <select
                                        className={BOT_FIELD_CLASS}
                                        disabled={
                                            configurationLocked ||
                                            requestingActivation ||
                                            allowedDeliveryTargetIds.length === 0
                                        }
                                        id="bot-completion-target"
                                        onChange={(event) => {
                                            configurationViewModel.setCompletionTarget(event.target.value);
                                        }}
                                        value={
                                            completionSelection.kind === "required" ? completionSelection.targetId : ""
                                        }
                                    >
                                        <option value="">Do not send a completion automatically</option>
                                        {ready.deliveryTargets
                                            .filter((target) =>
                                                allowedDeliveryTargetIds.includes(target.deliveryTargetId),
                                            )
                                            .map((target) => (
                                                <option key={target.deliveryTargetId} value={target.deliveryTargetId}>
                                                    {target.alias}
                                                </option>
                                            ))}
                                    </select>
                                </label>
                                {completionSelection.kind === "required" && (
                                    <label
                                        className="grid gap-1.5 text-xs font-semibold"
                                        htmlFor="bot-completion-template"
                                    >
                                        Completion message template
                                        <textarea
                                            aria-describedby="bot-completion-template-help"
                                            className={BOT_TEXTAREA_CLASS}
                                            disabled={configurationLocked || requestingActivation}
                                            id="bot-completion-template"
                                            maxLength={10000}
                                            onChange={(event) =>
                                                configurationViewModel.setCompletionTemplate(event.target.value)
                                            }
                                            value={completionSelection.messageTemplate}
                                        />
                                        <span
                                            className="font-normal leading-5 text-muted-foreground"
                                            id="bot-completion-template-help"
                                        >
                                            Use {`{status}`} where the completed turn state should appear.
                                        </span>
                                    </label>
                                )}
                                <p className="text-xs leading-5 text-muted-foreground">
                                    {identityOnly && !selectedAgentSupportsInstructions
                                        ? `${selectedAgent?.label ?? "This Agent"} is ready for identity-only Bots. Its ACP integration does not expose trusted embedded context for custom instructions.`
                                        : identityOnly
                                          ? "Identity-only behavior requires no instruction capability from the selected Agent."
                                          : "Required capability: embedded context. The selected Agent must support applying Bot behavior without treating it as ordinary user text."}
                                </p>
                                <div>
                                    <Button
                                        aria-busy={requestingActivation}
                                        className="min-h-11"
                                        disabled={
                                            configurationLocked ||
                                            requestingActivation ||
                                            connection.agents.length === 0
                                        }
                                        type="submit"
                                    >
                                        {requestingActivation ? (
                                            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                                        ) : (
                                            <ShieldCheck aria-hidden="true" className="size-4" />
                                        )}
                                        {requestingActivation ? "Activating…" : "Activate Bot"}
                                    </Button>
                                </div>
                            </form>
                        )}
                    </section>
                </div>

                <aside className="min-w-0">
                    <section aria-labelledby="bot-revisions-heading">
                        <div className="flex items-center justify-between gap-3">
                            <h2 className="text-base font-semibold" id="bot-revisions-heading">
                                Revisions
                            </h2>
                            {ready !== undefined && (
                                <span className="text-[11px] text-muted-foreground">
                                    {ready.behaviors.length} behavior{ready.behaviors.length === 1 ? "" : "s"}
                                </span>
                            )}
                        </div>
                        {ready !== undefined && ready.behaviors.length === 0 && (
                            <p className="mt-3 rounded-xl border border-dashed border-black/15 bg-white/60 p-4 text-xs leading-5 text-muted-foreground">
                                No behavior revision has been proposed yet.
                            </p>
                        )}
                        {ready !== undefined && ready.behaviors.length > 0 && (
                            <ol className="mt-3 grid gap-2">
                                {ready.behaviors.slice(0, 6).map((behavior) => {
                                    const binding = ready.bindings.find(
                                        (candidate) => candidate.behaviorRevisionId === behavior.behaviorRevisionId,
                                    );
                                    return (
                                        <li
                                            className="rounded-xl border-[0.5px] border-black/10 bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.03)]"
                                            key={behavior.behaviorRevisionId}
                                        >
                                            <div className="flex items-start justify-between gap-3">
                                                <strong className="text-xs font-semibold">
                                                    Behavior v{behavior.revisionNumber}
                                                </strong>
                                                <span
                                                    className={cn(
                                                        "rounded-full bg-black/5 px-2 py-1 text-[10px] font-semibold text-muted-foreground",
                                                        behavior.state.kind === "active" &&
                                                            "bg-[#e8f8ef] text-[#187747]",
                                                    )}
                                                >
                                                    {botBehaviorStatusLabel(behavior)}
                                                </span>
                                            </div>
                                            <p className="mt-2 line-clamp-3 text-xs leading-5 text-muted-foreground">
                                                {behavior.instructions.length > 0
                                                    ? behavior.instructions
                                                    : "Identity-only behavior"}
                                            </p>
                                            {binding !== undefined && (
                                                <dl className="mt-3 grid gap-1 rounded-lg bg-black/[0.025] p-3 text-[11px]">
                                                    <div className="flex justify-between gap-3">
                                                        <dt className="text-muted-foreground">Binding</dt>
                                                        <dd className="font-medium">
                                                            {botBindingStatusLabel(binding)}
                                                        </dd>
                                                    </div>
                                                    <div className="flex justify-between gap-3">
                                                        <dt className="text-muted-foreground">Target</dt>
                                                        <dd className="truncate font-mono">{binding.agentRef}</dd>
                                                    </div>
                                                    <div className="flex justify-between gap-3">
                                                        <dt className="text-muted-foreground">Workspace</dt>
                                                        <dd className="truncate font-mono">{binding.workspaceRef}</dd>
                                                    </div>
                                                    <div className="flex justify-between gap-3">
                                                        <dt className="text-muted-foreground">Outbound targets</dt>
                                                        <dd className="font-medium">
                                                            {binding.allowedDeliveryTargetIds.length}
                                                        </dd>
                                                    </div>
                                                </dl>
                                            )}
                                            {binding?.state instanceof MobiusUnavailableBotBindingState && (
                                                <p className="mt-2 text-[11px] leading-5 text-[#9b2c32]">
                                                    {binding.state.code}: {binding.state.message}
                                                </p>
                                            )}
                                            <time className="mt-3 block text-[10px] text-muted-foreground">
                                                {formatBotDate(behavior.createdAt)}
                                            </time>
                                        </li>
                                    );
                                })}
                            </ol>
                        )}
                    </section>

                    <section aria-labelledby="bot-lifecycle-heading" className="mt-8">
                        <h2 className="text-base font-semibold" id="bot-lifecycle-heading">
                            Lifecycle
                        </h2>
                        <div className="mt-3 rounded-2xl border-[0.5px] border-black/10 bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.03)]">
                            <div className="flex items-start gap-3">
                                <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-[#eefaf3] text-[#218854]">
                                    <CheckCircle2 aria-hidden="true" className="size-4" />
                                </span>
                                <span>
                                    <strong className="block text-sm font-semibold">
                                        Revision {bot.lifecycleRevision}
                                    </strong>
                                    <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                                        Lifecycle changes use optimistic revision checks.
                                    </span>
                                </span>
                            </div>
                            <div className="mt-4 grid gap-2">
                                {bot.state.kind === "active" && (
                                    <Button
                                        className="min-h-11 justify-start"
                                        disabled={changingLifecycle}
                                        onClick={() => void lifecycle.change("suspend", signal)}
                                        variant="outline"
                                    >
                                        <Pause aria-hidden="true" className="size-4" /> Suspend Bot
                                    </Button>
                                )}
                                {bot.state.kind === "suspended" && (
                                    <Button
                                        className="min-h-11 justify-start"
                                        disabled={changingLifecycle}
                                        onClick={() => void lifecycle.change("resume", signal)}
                                    >
                                        <Play aria-hidden="true" className="size-4" /> Resume Bot
                                    </Button>
                                )}
                                {bot.state.kind !== "archived" && !archiveConfirmationOpen && (
                                    <Button
                                        className="min-h-11 justify-start text-[#9b2c32] hover:text-[#9b2c32]"
                                        disabled={changingLifecycle}
                                        onClick={() => lifecycle.setArchiveConfirmationOpen(true)}
                                        variant="ghost"
                                    >
                                        <Trash2 aria-hidden="true" className="size-4" /> Archive Bot
                                    </Button>
                                )}
                                {archiveConfirmationOpen && (
                                    <div className="rounded-xl border border-[#f2c4c4] bg-[#fff7f7] p-3">
                                        <p className="text-xs leading-5 text-[#7f2429]">
                                            Archiving permanently blocks new revisions, connections, and turns.
                                        </p>
                                        <div className="mt-3 flex flex-wrap gap-2">
                                            <Button
                                                className="min-h-11 bg-[#8f252b] text-white hover:bg-[#781f24]"
                                                disabled={changingLifecycle}
                                                onClick={() => void lifecycle.change("archive", signal)}
                                            >
                                                <Trash2 aria-hidden="true" className="size-4" /> Confirm archive
                                            </Button>
                                            <Button
                                                aria-label="Cancel archive"
                                                className="min-h-11"
                                                disabled={changingLifecycle}
                                                onClick={() => lifecycle.setArchiveConfirmationOpen(false)}
                                                variant="ghost"
                                            >
                                                <X aria-hidden="true" className="size-4" /> Cancel
                                            </Button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </section>
                </aside>
            </div>
        </div>
    );
}
