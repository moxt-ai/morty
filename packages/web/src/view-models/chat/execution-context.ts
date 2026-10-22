import type { ExecutionContext } from "../../components/chat/execution-context.ts";
import type { BotRuntimeConfiguration } from "../../services/chat/bot-chat-api.ts";
import type { BotChatHomeStore } from "./bot-chat-home-store.ts";
import type { DraftControlsStore } from "./draft-controls-store.ts";
import type { OpenMobiusSession } from "./open-session.ts";
import type { SessionConnection } from "./session-pane-store.ts";

export type { ExecutionContext };

function directoryName(directory: string): string {
    return (
        directory
            .replace(/[\\/]+$/u, "")
            .split(/[\\/]/u)
            .at(-1) || directory
    );
}

export function pendingExecutionContext(
    home: BotChatHomeStore,
    settings: DraftControlsStore["settings"],
): ExecutionContext {
    const loading =
        home.selection.kind === "loading" || home.view.kind === "loading" || home.view.kind === "connecting";
    const base: ExecutionContext = {
        machine: home.runtimeConfiguration?.runtime.machineName.trim() || (loading ? "Loading…" : "Unknown"),
        agent: loading ? "Loading…" : "Unknown",
        directory: null,
        directoryName: loading ? "Loading…" : "Unknown",
        directoryPlaceholder: loading ? "Loading…" : "Unknown",
        connection: loading
            ? "Connecting"
            : home.selection.kind === "failed" || home.view.kind === "failed" || home.view.kind === "connection-failed"
              ? "Unavailable"
              : home.connectionStatus.label,
    };
    if (home.selection.kind !== "draft" || home.view.kind !== "active") {
        return base;
    }
    switch (settings.kind) {
        case "ready":
        case "refreshing":
            return {
                ...base,
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
    configuration: BotRuntimeConfiguration | null,
    connection: SessionConnection,
): ExecutionContext {
    const agent = configuration?.runtime.agents.find((candidate) => candidate.agentRef === session.agentRef);
    const base = {
        machine: configuration?.runtime.machineName.trim() || "Unknown",
        agent: agent?.label.trim() || session.result.ready.agentName.trim() || "Unknown",
        directory: session.result.ready.directoryLabel,
        directoryName: directoryName(session.result.ready.directoryLabel),
        directoryPlaceholder: "Unknown",
    };
    switch (connection.kind) {
        case "loading":
            return { ...base, connection: "Connecting" };
        case "ready":
            return { ...base, connection: "Connected" };
        case "disconnected":
            return { ...base, connection: "Disconnected" };
        case "reconnecting":
            return { ...base, connection: "Reconnecting" };
        case "failed":
            return { ...base, connection: "Unavailable" };
    }
}
