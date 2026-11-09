import {
    decodeMortyChannelDescriptor,
    decodeMortyRuntimeList,
    decodeMortyRuntimePairingStatus,
    MortyRuntimePairingLifecycle,
} from "@morty-build/client";
import { describe, expect, it } from "vitest";

const runtime = {
    agents: [
        {
            agentPath: "/usr/local/bin/codex",
            agentVersion: "codex-cli 1.0.0",
            capabilities: {
                audioPrompt: false,
                closeSession: false,
                deleteSession: false,
                embeddedContextPrompt: false,
                imagePrompt: false,
                listSessions: false,
                loadSession: false,
                promptQueueing: false,
                renameSession: false,
                resumeSession: false,
                steering: false,
                unstableForkSession: false,
            },
            id: "codex",
            label: "Codex",
        },
    ],
    machineName: "MacBook",
    online: true,
    computerId: "project-1",
    workspaceName: "contract",
};

const pairedStatus = {
    agents: [],
    machineName: "MacBook",
    computerId: "project-1",
    status: "paired",
    workspaceName: "contract",
};

describe("Runtime descriptor decoding contracts", () => {
    it("Given a Runtime list, When it is decoded, Then its Agents are available", () => {
        const decoded = decodeMortyRuntimeList({ runtimes: [runtime] });
        expect(decoded[0]?.agents[0]?.id).toBe("codex");
    });

    it.each([{}, null, { steering: "yes" }])(
        "Given a Runtime with an incomplete or malformed capability catalog, When it is decoded, Then no capabilities are guessed",
        (capabilities) => {
            const agents = runtime.agents.map((agent) => ({ ...agent, capabilities }));
            expect(() => decodeMortyRuntimeList({ runtimes: [{ ...runtime, agents }] })).toThrow();
        },
    );

    it("Given an unknown capability field, When a Runtime is decoded, Then a different catalog contract is rejected", () => {
        const agents = runtime.agents.map((agent) => ({
            ...agent,
            capabilities: { ...agent.capabilities, future: true },
        }));
        expect(() => decodeMortyRuntimeList({ runtimes: [{ ...runtime, agents }] })).toThrow();
    });

    it("Given a paired status, When it is decoded, Then it is accepted", () => {
        const decoded = decodeMortyRuntimePairingStatus(pairedStatus);
        expect(decoded.status).toBe(MortyRuntimePairingLifecycle.Paired);
    });

    it("Given a channel descriptor, When it is decoded, Then it is accepted", () => {
        expect(() => decodeMortyChannelDescriptor(runtime)).not.toThrow();
    });
});
