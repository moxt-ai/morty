import type { ExecutionContext } from "../../components/chat/execution-context.ts";
import type { BotRuntimeConfiguration } from "../../services/chat/bot-chat-api.ts";
import { type BotChatHomeStore, homeCanStartConversation } from "./bot-chat-home-store.ts";
import { connectionPresentation } from "./connection-presentation.ts";
import { directoryName } from "./directory-name.ts";
import type { DraftControlsStore } from "./draft-controls-store.ts";
import type { SelectedMobiusSession } from "./open-session.ts";
import type { SessionConnection } from "./session-pane-store.ts";

export type { ExecutionContext };

export function pendingExecutionContext(
    home: BotChatHomeStore,
    settings: DraftControlsStore["settings"],
): ExecutionContext {
    const loading = home.selection.kind === "loading" || home.initialization.kind === "loading";
    const base: ExecutionContext = {
        ...connectionPresentation(home, null),
        agentRef: "",
        machine: home.runtimeConfiguration?.runtime.machineName.trim() || (loading ? "Loading…" : "Unknown"),
        agent: loading ? "Loading…" : "Unknown",
        directory: null,
        directoryName: loading ? "Loading…" : "Unknown",
        directoryPlaceholder: loading ? "Loading…" : "Unknown",
    };
    if (home.selection.kind !== "draft" || !homeCanStartConversation(home)) {
        return base;
    }
    switch (settings.kind) {
        case "ready":
        case "refreshing": {
            // The draft only chose which agent runs; its names come from the Runtime configuration the page follows.
            const runtime = home.runtimeConfiguration?.runtime;
            const offered = runtime?.agents.find((agent) => agent.agentRef === settings.selectedAgent.agentRef);
            return {
                ...base,
                agentRef: settings.selectedAgent.agentRef,
                machine: runtime?.machineName.trim() || settings.selectedAgent.machineName.trim() || "Unknown",
                agent: offered?.label.trim() || settings.selectedAgent.label.trim() || "Unknown",
                directory: settings.cwd.directoryLabel,
                directoryName: directoryName(settings.cwd.directoryLabel),
            };
        }
        case "loading":
        case "waiting-agent":
        case "switching":
            return { ...base, agent: "Loading…", directoryName: "Loading…", directoryPlaceholder: "Loading…" };
        case "failed":
        case "waiting-runtime":
            return base;
    }
}

function sessionHarnessIdentity(
    session: SelectedMobiusSession,
    configuration: BotRuntimeConfiguration | null,
): { readonly agentRef: string; readonly agent: string } {
    const agent = configuration?.runtime.agents.find((candidate) => candidate.agentRef === session.agentRef);
    return {
        agentRef: session.agentRef,
        agent: agent?.label.trim() || session.result.ready.agentName.trim() || "Unknown",
    };
}

export function activeHarnessMark(
    home: BotChatHomeStore,
    settings: DraftControlsStore["settings"],
): { readonly agentRef: string; readonly label: string } {
    if (home.selection.kind === "ready") {
        const identity = sessionHarnessIdentity(home.selection.session, home.runtimeConfiguration);
        return { agentRef: identity.agentRef, label: identity.agent };
    }
    const context = pendingExecutionContext(home, settings);
    return { agentRef: context.agentRef, label: context.agent };
}

export function sessionExecutionContext(
    session: SelectedMobiusSession,
    home: BotChatHomeStore,
    connection: SessionConnection,
): ExecutionContext {
    const configuration = home.runtimeConfiguration;
    const identity = sessionHarnessIdentity(session, configuration);

    return {
        ...connectionPresentation(home, connection),
        agentRef: identity.agentRef,
        machine: configuration?.runtime.machineName.trim() || "Unknown",
        agent: identity.agent,
        directory: session.result.ready.directoryLabel,
        directoryName: directoryName(session.result.ready.directoryLabel),
        directoryPlaceholder: "Unknown",
    };
}
