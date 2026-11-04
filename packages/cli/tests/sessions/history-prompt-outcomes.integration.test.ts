import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeSessionEventEnvelope,
    decodeSessionHistoryPageLoaded,
    encodeSessionHistoryPageLoad,
    encodeSessionPromptCommand,
    encodeSessionPromptDispositionCommand,
    type NativeSessionEvents,
    SESSION_PROMPT_DISPOSITION_KIND,
    type SessionLiveEvent,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import { ControlledAcpAgentSpecification } from "../support/agents/controlled-acp.ts";
import { prepareNewRealSession, type RealDaemonPeer, withControlledDaemon } from "../support/agents/real-daemon.ts";
import { writeControlledAcpExecutable } from "../support/controlled-acp-executable.ts";

const submit = (peer: RealDaemonPeer, sessionId: string, commandId: string, prompt: string, targetCommandId?: string) =>
    peer.send(
        encodeSessionPromptCommand({
            additionalDirectoryIds: [],
            agentId: "controlled-acp",
            attachments: [],
            bindingId: peer.bindingId,
            commandId,
            directoryId: "default",
            ...(targetCommandId === undefined
                ? { disposition: "reject", targetCommandId: "" }
                : { disposition: "queue", targetCommandId }),
            kind: "session.prompt",
            prompt,
            sessionId,
        }),
    );

async function liveUntil(peer: RealDaemonPeer, matches: (event: SessionLiveEvent) => boolean): Promise<void> {
    for (;;) {
        const raw = await peer.nextMessage();
        if (decodeMessageKind(raw) !== "session.event.v2") {
            continue;
        }
        for (const event of decodeSessionEventEnvelope(raw).events) {
            if (matches(event)) {
                return;
            }
        }
    }
}

const terminal = (commandId: string) => (event: SessionLiveEvent) =>
    event.type === "lifecycle-metadata" &&
    (event.payload.kind === "prompt.completed" || event.payload.kind === "prompt.failed") &&
    event.payload.commandId === commandId;

async function historyPage(peer: RealDaemonPeer, sessionId: string): Promise<NativeSessionEvents> {
    const requestId = randomUUID();
    peer.send(
        encodeSessionHistoryPageLoad({
            kind: "session.live-history.v2.page.load",
            requestId,
            sessionId,
            eventLimit: 1_000,
            cursor: null,
        }),
    );
    for (;;) {
        const raw = await peer.nextMessage();
        const kind = decodeMessageKind(raw);
        if (kind === "session.operation.failed") {
            throw new Error(raw);
        }
        if (kind === "session.live-history.v2.page.loaded") {
            const loaded = decodeSessionHistoryPageLoaded(raw);
            if (loaded.requestId === requestId) {
                return loaded.events;
            }
        }
    }
}

test("Given a failed turn and a completed turn, When a client reads the Session history, Then each user message is named with its command and how that command ended", async () => {
    const directory = await mkdtemp(join(tmpdir(), "history-outcomes-"));
    try {
        const executableDirectory = await writeControlledAcpExecutable(directory, { loadSession: true });
        await withControlledDaemon(
            new ControlledAcpAgentSpecification(),
            { MOBIUS_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent"), PATH: executableDirectory },
            async (peer) => {
                const failed = randomUUID();
                const completed = randomUUID();
                const sessionId = await prepareNewRealSession(peer, "controlled-acp");
                // The failed prompt retires the Agent process, so the history read after it replays the Agent's own
                // transcript, which holds no command identity.
                submit(peer, sessionId, failed, "fail with model unavailable");
                await liveUntil(peer, terminal(failed));
                submit(peer, sessionId, completed, "The request completes");
                await liveUntil(peer, terminal(completed));

                const page = await historyPage(peer, sessionId);

                const userMessages = page.events.events.flatMap((event) =>
                    event.type === "acp" && event.payload.sessionUpdate === "user_message_chunk"
                        ? [event.payload.messageId]
                        : [],
                );
                expect(userMessages).toEqual(["user-1", "user-2"]);
                expect(page.events.promptOutcomes).toEqual(
                    expect.arrayContaining([
                        {
                            payload: expect.objectContaining({
                                code: "acp_agent_error",
                                commandId: failed,
                                kind: "prompt.failed",
                                message: "Internal error: Model unavailable: controlled/test-model",
                                messageId: "user-1",
                            }),
                            recordedAt: expect.any(String),
                        },
                        {
                            payload: {
                                commandId: completed,
                                kind: "prompt.completed",
                                messageId: "user-2",
                                stopReason: "end_turn",
                            },
                            recordedAt: expect.any(String),
                        },
                    ]),
                );
                expect(page.events.promptOutcomes).toHaveLength(2);
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}, 120_000);

test("Given a turn steered by a queued prompt, When a client reads the Session history, Then the steering's outcome names the user message it added to that turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "history-steered-"));
    try {
        const executableDirectory = await writeControlledAcpExecutable(directory, { loadSession: true });
        await withControlledDaemon(
            new ControlledAcpAgentSpecification(),
            { MOBIUS_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent"), PATH: executableDirectory },
            async (peer) => {
                const turn = randomUUID();
                const steering = randomUUID();
                const sessionId = await prepareNewRealSession(peer, "controlled-acp");
                submit(peer, sessionId, turn, "wait for steering");
                await liveUntil(
                    peer,
                    (event) =>
                        event.type === "lifecycle-metadata" &&
                        event.payload.kind === "prompt.started" &&
                        event.payload.commandId === turn,
                );
                submit(peer, sessionId, steering, "Apply the steering instruction", turn);
                await liveUntil(
                    peer,
                    (event) => event.type === "lifecycle-metadata" && event.payload.kind === "session.queue.changed",
                );
                peer.send(
                    encodeSessionPromptDispositionCommand({
                        commandId: steering,
                        disposition: "steer",
                        kind: SESSION_PROMPT_DISPOSITION_KIND,
                        sessionId,
                    }),
                );
                // The steering prompt and the turn it joined settle in either order.
                const settled = new Set<string>();
                await liveUntil(peer, (event) => {
                    for (const commandId of [turn, steering]) {
                        if (terminal(commandId)(event)) {
                            settled.add(commandId);
                        }
                    }
                    return settled.size === 2;
                });

                const page = await historyPage(peer, sessionId);

                const userMessages = page.events.events.flatMap((event) =>
                    event.type === "acp" && event.payload.sessionUpdate === "user_message_chunk"
                        ? [event.payload.messageId]
                        : [],
                );
                expect(userMessages).toHaveLength(2);
                expect(page.events.promptOutcomes).toEqual(
                    expect.arrayContaining([
                        {
                            payload: {
                                commandId: steering,
                                kind: "prompt.completed",
                                messageId: userMessages[1],
                                stopReason: "steered",
                            },
                            recordedAt: expect.any(String),
                        },
                    ]),
                );
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}, 120_000);
