// @vitest-environment happy-dom

import type { NativeSessionEntry, NativeSessionResult } from "@moxt-ai/mobius-sdk/channel";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { dataTestId } from "../../src/data-testid.ts";
import type { BotChatApi } from "../../src/services/chat/bot-chat-api.ts";
import { NativeSessionDialog, type OpenMobiusSession } from "../../src/views/chat/native-session-dialog.tsx";

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

const imported: NativeSessionResult = {
    action: "import",
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
        requestId: "import-request",
        restored: true,
        sessionId: "imported-session",
    },
    requestId: "import-request",
    sessionId: "discovery-session",
    targetSessionId: "imported-session",
    title: "Active Codex session",
};

afterEach(() => {
    document.body.replaceChildren();
});

it("Given a listed local session, When a user selects and imports it, Then Chat offers Import before Fork and opens the imported session", async () => {
    const actions: string[] = [];
    let opened: OpenMobiusSession | null = null;
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
            return input.action === "list" ? listed : imported;
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
            createElement(NativeSessionDialog, {
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
    const importedSession = document.querySelector<HTMLButtonElement>(
        `[data-testid="${dataTestId.importLocalSession}"]`,
    );
    const fork = document.querySelector<HTMLButtonElement>(`[data-testid="${dataTestId.forkLocalSession}"]`);
    if (importedSession === null || fork === null) {
        throw new Error("The Import and Fork actions were not rendered");
    }
    expect(Array.from(document.querySelectorAll("footer button"), (button) => button.textContent)).toEqual([
        "Cancel",
        "Import",
        "Fork",
    ]);
    expect(importedSession.disabled).toBe(false);
    await act(async () => importedSession.click());

    expect(actions).toEqual(["list", "preview", "import"]);
    expect(opened).toMatchObject({
        entry: { entryId: "native-entry" },
        result: { action: "import", ready: { sessionId: "imported-session" } },
    });
    await act(async () => root.unmount());
});
