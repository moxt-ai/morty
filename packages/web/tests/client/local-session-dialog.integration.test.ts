// @vitest-environment happy-dom

import type { NativeSessionEntry, NativeSessionResult } from "@moxt-ai/mobius-sdk/channel";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { dataTestId } from "../../src/data-testid.ts";
import type { BotChatApi } from "../../src/services/chat/bot-chat-api.ts";
import { LocalSessionDialog, type OpenLocalSession } from "../../src/views/chat/local-session-dialog.tsx";

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const entry: NativeSessionEntry = {
    additionalDirectories: [],
    directoryId: "default",
    directoryLabel: "Workspace",
    entryId: "native-entry",
    title: "Active Codex session",
    updatedAt: "2026-09-16T06:00:00.000Z",
};

const capabilities = {
    additionalDirectories: true,
    audioPrompt: false,
    closeSession: true,
    deleteSession: true,
    embeddedContextPrompt: true,
    imagePrompt: true,
    listSessions: true,
    loadSession: true,
    promptQueueing: false,
    resumeSession: true,
    steering: false,
    unstableForkSession: true,
} as const;

const listed: NativeSessionResult = {
    action: "list",
    capabilities,
    entries: [entry],
    kind: "native.session.result",
    nextCursor: null,
    requestId: "list-request",
    sessionId: "discovery-session",
};

const forked: NativeSessionResult = {
    action: "fork",
    history: { coveredCommandIds: [], coveredMessageIds: [], messages: [], status: "available", truncated: false },
    kind: "native.session.result",
    ready: {
        additionalDirectories: [],
        agentId: "codex",
        agentName: "Codex",
        agentVersion: "test",
        capabilities,
        commands: [],
        configOptions: [],
        directoryId: "default",
        directoryLabel: "Workspace",
        kind: "session.ready",
        requestId: "fork-request",
        restored: true,
        sessionId: "forked-session",
    },
    requestId: "fork-request",
    sessionId: "discovery-session",
    targetSessionId: "forked-session",
    title: "Active Codex session",
};

afterEach(() => {
    document.body.replaceChildren();
});

it("Given a listed local session, When a user selects and forks it, Then Chat previews its history before creating the fork", async () => {
    const actions: string[] = [];
    let opened: OpenLocalSession | null = null;
    const requests: Pick<BotChatApi, "workspace" | "nativeSessions" | "nativeSession"> = {
        workspace: async () => ({
            agents: [
                { agentRef: "codex", label: "Codex", machineName: "Local Mac", online: true, runtimeId: "runtime" },
            ],
            selected: null,
            status: "active",
        }),
        nativeSessions: async (_botId, _runtimeId, input) => {
            actions.push(input.action);
            return input.action === "list" ? listed : forked;
        },
        nativeSession: async () => {
            actions.push("preview");
            return {
                title: "Active Codex session",
                history: {
                    coveredCommandIds: [],
                    coveredMessageIds: [],
                    messages: [{ role: "user", text: "Explain the session preview" }],
                    status: "available",
                    truncated: false,
                },
            };
        },
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(
            createElement(LocalSessionDialog, {
                botId: "bot",
                requests,
                onOpen: (session) => {
                    opened = session;
                },
                onClose: () => {},
            }),
        );
    });
    const session = document.querySelector<HTMLButtonElement>(`[data-testid="${dataTestId.localSessionEntry}"]`);
    if (session === null) {
        throw new Error("The local session was not rendered");
    }
    await act(async () => session.click());
    const preview = document.querySelector<HTMLElement>(`[aria-label="Selected session preview"]`);
    expect(preview?.textContent).toContain("Explain the session preview");
    const fork = document.querySelector<HTMLButtonElement>(`[data-testid="${dataTestId.forkLocalSession}"]`);
    if (fork === null) {
        throw new Error("The Fork action was not rendered");
    }
    expect(fork.disabled).toBe(false);
    await act(async () => fork.click());

    expect(actions).toEqual(["list", "preview", "fork"]);
    expect(opened).toMatchObject({ entry: { entryId: "native-entry" }, result: { sessionId: "discovery-session" } });
    await act(async () => root.unmount());
});
