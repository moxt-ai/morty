import {
    decodeAgentSettingsDiscoveredEvent,
    decodeSessionEventLogPage,
    decodeSessionPermissionRequestedEvent,
    decodeSessionsListedEvent,
} from "@morty-build/client/protocol";
import { expect, it } from "vitest";

it("Given a permission request without its execution context, When it crosses the Runtime boundary, Then the retired form is rejected", () => {
    const permission = {
        kind: "session.permission.requested",
        commandId: "command-1",
        interactionId: "interaction-1",
        sessionId: "session-1",
        title: "Read file",
        toolCallId: "tool-1",
        toolKind: "read",
        options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
    };
    expect(() => decodeSessionPermissionRequestedEvent(JSON.stringify(permission))).toThrow();
    const current = { ...permission, details: { cwd: "/workspace", locations: [] } };
    expect(decodeSessionPermissionRequestedEvent(JSON.stringify(current))).toEqual(current);
});

it("Given Agent settings without the inspected directory, When a client decodes them, Then it rejects the retired response instead of applying settings to another directory", () => {
    const settings = {
        kind: "agent.settings.discovered",
        agentId: "agent-1",
        agentName: "Claude",
        agentVersion: "2",
        requestId: "request-1",
        settings: [],
        settingsRevision: "a".repeat(64),
        modelEffort: {
            effortSettingId: "",
            modelSettingId: "",
            resolution: "unavailable",
            unsupportedModelIds: [],
            valuesByModel: {},
        },
    };
    expect(() => decodeAgentSettingsDiscoveredEvent(JSON.stringify(settings))).toThrow();
    const current = { ...settings, directoryId: "default" };
    expect(decodeAgentSettingsDiscoveredEvent(JSON.stringify(current))).toEqual(current);
    const { unsupportedModelIds: _, ...retiredEffort } = current.modelEffort;
    expect(() =>
        decodeAgentSettingsDiscoveredEvent(JSON.stringify({ ...current, modelEffort: retiredEffort })),
    ).toThrow();
});

it("Given history without prompt outcomes, When a client decodes it, Then it rejects the retired page", () => {
    const page = {
        events: [],
        nextCursor: null,
        sessionGenerationId: "generation-1",
        tailCursor: "",
        throughPosition: "0",
        truncated: false,
        version: 2,
    };
    expect(() => decodeSessionEventLogPage(JSON.stringify(page))).toThrow();
    expect(decodeSessionEventLogPage(JSON.stringify({ ...page, promptOutcomes: [] }))).toEqual({
        ...page,
        promptOutcomes: [],
    });
});
it("Given a session list entry without status, When a client decodes it, Then it rejects the retired entry", () => {
    const entry = {
        additionalDirectories: [],
        agentId: "agent-1",
        directoryId: "default",
        directoryLabel: "Workspace",
        prompted: false,
        sessionId: "session-1",
        title: "Session",
        updatedAt: "2026-11-07T00:00:00.000Z",
    };
    const page = { kind: "session.listed", entries: [entry], requestId: "request-1" };
    expect(() => decodeSessionsListedEvent(JSON.stringify(page))).toThrow();
    const current = { ...page, entries: [{ ...entry, status: { kind: "idle" } }] };
    expect(decodeSessionsListedEvent(JSON.stringify(current))).toEqual(current);
});
