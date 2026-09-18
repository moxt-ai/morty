import type { SlackPlatformGateway } from "../../../src/components/slack/entity/slack-platform-gateway.ts";

// Stateful fake for the generic Project Session boundary used by Slack.
export class InMemoryMobius implements SlackPlatformGateway {
    readonly runs: {
        readonly botId: string;
        readonly clientMessageId: string;
        readonly conversationId: string;
        readonly instructions: string;
        readonly prompt: string;
    }[] = [];
    readonly results = new Map<string, string>();
    readonly #sessions = new Map<string, string>();
    responseText = "Investigation complete";
    connectionState: "connected" | "disconnect-after-result" = "connected";
    #gate: { readonly started: () => void; readonly completed: Promise<void> } | null = null;

    readonly pauseNext = () => {
        let started: () => void = () => undefined;
        let complete: () => void = () => undefined;
        const startedPromise = new Promise<void>((resolve) => {
            started = resolve;
        });
        const completed = new Promise<void>((resolve) => {
            complete = resolve;
        });
        this.#gate = { started, completed };
        return { started: startedPromise, complete };
    };

    readonly createPairing = async (_projectId: string, _idempotencyKey: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        return { pairingId: "pairing-1", pairingCode: "PAIR-ONE", status: "pending" };
    };

    readonly readPairing = async (_projectId: string, _pairingId: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        return { status: "pending" };
    };

    readonly openAutomatedChatSession = async (
        _projectId: string,
        selection: { readonly bindingId: string },
        sessionId: string,
        _title: string,
        signal: AbortSignal,
    ): Promise<string> => {
        signal.throwIfAborted();
        const existing = this.#sessions.get(sessionId);
        if (existing !== undefined && existing !== selection.bindingId) {
            throw new Error("Session binding changed");
        }
        this.#sessions.set(sessionId, selection.bindingId);
        return sessionId;
    };

    readonly submitAutomatedChatTurn = async (
        _projectId: string,
        sessionId: string,
        input: { readonly commandId: string; readonly prompt: string; readonly instructions: string },
        signal: AbortSignal,
    ): Promise<{ readonly text: string; readonly stopReason: string }> => {
        signal.throwIfAborted();
        if (!this.results.has(input.commandId)) {
            this.runs.push({
                botId: "chat-bot-1",
                clientMessageId: input.commandId,
                conversationId: sessionId,
                instructions: input.instructions,
                prompt: input.prompt,
            });
            const gate = this.#gate;
            this.#gate = null;
            if (gate !== null) {
                gate.started();
                await waitForGate(gate.completed, signal);
            }
            this.results.set(input.commandId, this.responseText);
            if (this.connectionState === "disconnect-after-result") {
                this.connectionState = "connected";
                throw new TypeError("Connection closed");
            }
        }
        return { text: this.results.get(input.commandId) ?? "", stopReason: "end_turn" };
    };
}

async function waitForGate(completed: Promise<void>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
        const aborted = () => {
            signal.removeEventListener("abort", aborted);
            reject(signal.reason);
        };
        signal.addEventListener("abort", aborted, { once: true });
        void completed.then(() => {
            signal.removeEventListener("abort", aborted);
            resolve();
        }, reject);
    });
    signal.throwIfAborted();
}
