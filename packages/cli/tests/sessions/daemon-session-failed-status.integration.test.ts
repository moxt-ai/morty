import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeSessionStatusChangedEvent,
    decodeSessionsQueriedEvent,
    encodeSessionPromptCommand,
    encodeSessionQueryCommand,
    SESSION_STATUS_CHANGED_KIND,
    type SessionStatus,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { ControlledAcpAgentSpecification } from "../support/agents/controlled-acp.ts";
import { prepareNewRealSession, type RealDaemonPeer, withControlledDaemon } from "../support/agents/real-daemon.ts";
import { writeControlledAcpExecutable } from "../support/controlled-acp-executable.ts";

const submit = (peer: RealDaemonPeer, sessionId: string, commandId: string, prompt: string) =>
    peer.send(
        encodeSessionPromptCommand({
            additionalDirectoryIds: [],
            agentId: "controlled-acp",
            attachments: [],
            bindingId: peer.bindingId,
            commandId,
            directoryId: "default",
            disposition: "reject",
            kind: "session.prompt",
            prompt,
            sessionId,
            targetCommandId: "",
        }),
    );

/** The next idle status the Runtime publishes for the Session. */
async function nextIdle(peer: RealDaemonPeer, sessionId: string): Promise<SessionStatus> {
    for (;;) {
        const message = await peer.nextMessage();
        if (decodeMessageKind(message) !== SESSION_STATUS_CHANGED_KIND) {
            continue;
        }
        const changed = decodeSessionStatusChangedEvent(message);
        if (changed.sessionId === sessionId && changed.status.kind === "idle") {
            return changed.status;
        }
    }
}

async function queriedStatus(peer: RealDaemonPeer, sessionId: string): Promise<SessionStatus | undefined> {
    const requestId = randomUUID();
    peer.send(encodeSessionQueryCommand({ kind: "session.query", requestId, sessionIds: [sessionId] }));
    for (;;) {
        const message = await peer.nextMessage();
        if (decodeMessageKind(message) === "session.queried") {
            const queried = decodeSessionsQueriedEvent(message);
            if (queried.requestId === requestId) {
                return queried.entries.find((entry) => entry.sessionId === sessionId)?.status;
            }
        }
    }
}

test("Given a Session whose last turn failed, When a client that did not watch it reads its status, Then the Session reports the failure until another turn completes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "failed-status-"));
    try {
        const executableDirectory = await writeControlledAcpExecutable(directory, { loadSession: true });
        await withControlledDaemon(
            new ControlledAcpAgentSpecification(),
            { MORTY_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent"), PATH: executableDirectory },
            async (peer) => {
                const failed = randomUUID();
                const sessionId = await prepareNewRealSession(peer, "controlled-acp");
                submit(peer, sessionId, failed, "fail with model unavailable");
                const failure = { code: "acp_agent_error", commandId: failed, message: expect.any(String) };
                expect(await nextIdle(peer, sessionId)).toEqual({ kind: "idle", failedTurn: failure });

                // A client that connects later, here after a restart, reads the same failure.
                await peer.restart();
                expect(await queriedStatus(peer, sessionId)).toEqual({ kind: "idle", failedTurn: failure });

                submit(peer, sessionId, randomUUID(), "The request completes");
                expect(await nextIdle(peer, sessionId)).toEqual({ kind: "idle" });
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}, 120_000);
