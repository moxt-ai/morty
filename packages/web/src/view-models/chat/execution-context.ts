import type { ExecutionContext } from "../../components/chat/execution-context.ts";
import type { BotChatHomeStore } from "./bot-chat-home-store.ts";
import { connectionPresentation } from "./connection-presentation.ts";
import { directoryName } from "./directory-name.ts";
import type { DraftControlsStore } from "./draft-controls-store.ts";
import type { OpenMobiusSession } from "./open-session.ts";
import type { SessionConnection } from "./session-pane-store.ts";

export type { ExecutionContext };

export function pendingExecutionContext(
    home: BotChatHomeStore,
    settings: DraftControlsStore["settings"],
): ExecutionContext {
    const loading =
        home.selection.kind === "loading" || home.view.kind === "loading" || home.view.kind === "connecting";
    const base: ExecutionContext = {
        ...connectionPresentation(home, null),
        agentRef: "",
        machine: home.runtimeConfiguration?.runtime.machineName.trim() || (loading ? "Loading…" : "Unknown"),
        agent: loading ? "Loading…" : "Unknown",
        directory: null,
        directoryName: loading ? "Loading…" : "Unknown",
        directoryPlaceholder: loading ? "Loading…" : "Unknown",
    };
    if (home.selection.kind !== "draft" || home.view.kind !== "active") {
        return base;
    }
    switch (settings.kind) {
        case "ready":
        case "refreshing":
            return {
                ...base,
                agentRef: settings.selectedAgent.agentRef,
                machine: settings.selectedAgent.machineName.trim() || "Unknown",
                agent: settings.selectedAgent.label.trim() || "Unknown",
                directory: settings.cwd.directoryLabel,
                directoryName: directoryName(settings.cwd.directoryLabel),
            };
        case "loading":
        case "switching":
            return { ...base, agent: "Loading…", directoryName: "Loading…", directoryPlaceholder: "Loading…" };
        case "failed":
            return base;
    }
}

export function sessionExecutionContext(
    session: OpenMobiusSession,
    home: BotChatHomeStore,
    connection: SessionConnection,
): ExecutionContext {
    const configuration = home.runtimeConfiguration;
    const agent = configuration?.runtime.agents.find((candidate) => candidate.agentRef === session.agentRef);

    return {
        ...connectionPresentation(home, connection),
        agentRef: session.agentRef,
        machine: configuration?.runtime.machineName.trim() || "Unknown",
        agent: agent?.label.trim() || session.result.ready.agentName.trim() || "Unknown",
        directory: session.result.ready.directoryLabel,
        directoryName: directoryName(session.result.ready.directoryLabel),
        directoryPlaceholder: "Unknown",
    };
}
