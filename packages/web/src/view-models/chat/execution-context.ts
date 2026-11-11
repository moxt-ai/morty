import type { ExecutionContext } from "../../components/chat/execution-context.ts";
import type { BotComputerConfiguration } from "../../services/chat/bot-chat-api.ts";
import { type BotChatHomeStore, homeCanStartConversation } from "./bot-chat-home-store.ts";
import { connectionPresentation } from "./connection-presentation.ts";
import { directoryName } from "./directory-name.ts";
import type { DraftControlsStore } from "./draft-controls-store.ts";
import type { SelectedMortySession } from "./open-session.ts";
import type { SessionConnection } from "./session-pane-store.ts";

export type { ExecutionContext };

export function pendingExecutionContext(
    home: BotChatHomeStore,
    settings: DraftControlsStore["settings"],
): ExecutionContext {
    const loading = home.selection.kind === "loading" || home.initialization.kind === "loading";
    const base: ExecutionContext = {
        ...connectionPresentation(home, null),
        harness: "",
        machine: home.computerConfiguration?.computer.machineName.trim() || (loading ? "Loading…" : "Unknown"),
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
            // The draft only chose which agent runs; its names come from the Computer configuration the page follows.
            const computer = home.computerConfiguration?.computer;
            const offered = computer?.agents.find((agent) => agent.harness === settings.selectedAgent.harness);
            return {
                ...base,
                harness: settings.selectedAgent.harness,
                machine: computer?.machineName.trim() || settings.selectedAgent.machineName.trim() || "Unknown",
                agent: offered?.label.trim() || settings.selectedAgent.label.trim() || "Unknown",
                directory: settings.cwd.directoryLabel,
                directoryName: directoryName(settings.cwd.directoryLabel),
            };
        }
        case "loading":
        case "switching":
            return { ...base, agent: "Loading…", directoryName: "Loading…", directoryPlaceholder: "Loading…" };
        case "failed":
        case "unreachable":
            return base;
    }
}

function sessionHarnessIdentity(
    session: SelectedMortySession,
    configuration: BotComputerConfiguration | null,
): { readonly harness: string; readonly agent: string } {
    const agent = configuration?.computer.agents.find((candidate) => candidate.harness === session.harness);
    return {
        harness: session.harness,
        agent: agent?.label.trim() || session.result.ready.agentName.trim() || "Unknown",
    };
}

export function activeHarnessMark(
    home: BotChatHomeStore,
    settings: DraftControlsStore["settings"],
): { readonly harness: string; readonly label: string } {
    if (home.selection.kind === "ready") {
        const identity = sessionHarnessIdentity(home.selection.session, home.computerConfiguration);
        return { harness: identity.harness, label: identity.agent };
    }
    const context = pendingExecutionContext(home, settings);
    return { harness: context.harness, label: context.agent };
}

export function sessionExecutionContext(
    session: SelectedMortySession,
    home: BotChatHomeStore,
    connection: SessionConnection,
): ExecutionContext {
    const configuration = home.computerConfiguration;
    const identity = sessionHarnessIdentity(session, configuration);

    return {
        ...connectionPresentation(home, connection),
        harness: identity.harness,
        machine: configuration?.computer.machineName.trim() || "Unknown",
        agent: identity.agent,
        directory: session.result.ready.directoryLabel,
        directoryName: directoryName(session.result.ready.directoryLabel),
        directoryPlaceholder: "Unknown",
    };
}
