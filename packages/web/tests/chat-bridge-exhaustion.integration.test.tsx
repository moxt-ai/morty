import { getByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import {
    CHAT_BRIDGE_HANDSHAKE_TIMEOUT_MILLISECONDS,
    WebSocketApiTransport,
} from "../src/services/api/websocket-api-transport.ts";
import { ANONYMOUS_CREDENTIAL_KEY_NAME } from "../src/services/identity/anonymous-identity-api.ts";
import { encodeIdentityScope } from "../src/services/identity/identity-scope-url.ts";
import { anonymousCredentialsEntry, centralLocalStorage } from "../src/services/local-storage/central-local-storage.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createBridgeProxy } from "./infra/bridge-proxy.ts";
import { createTestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";
import { createChatWorkerEnvironment } from "./support/chat-worker.ts";

const CLOCK_ORIGIN = "2026-10-13T08:00:00Z";
const RECONNECT_DELAYS_MILLISECONDS = [1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000];

function agentAnswered(app: Awaited<ReturnType<typeof createTestApp>>, text: string): boolean {
    return app.elementsByTestId(dataTestId.agentResponse).some((message) => message.textContent?.includes(text));
}

/**
 * Drives the transport's whole bounded reconnect budget against a bridge that
 * accepts each dial but never completes the handshake. Every attempt is spent on
 * the injected clock's handshake deadline, so exhaustion is deterministic rather
 * than dependent on real connection timing. This mirrors the transport-boundary
 * loop in `chat-bridge-retry`, wrapped in `act` so each store transition the
 * exhaustion triggers is flushed to the DOM.
 */
async function spendReconnectBudget(clock: TestClock): Promise<void> {
    for (const delay of RECONNECT_DELAYS_MILLISECONDS) {
        await act(async () => {
            clock.advanceBy(delay);
        });
        // The dial armed its own handshake deadline; flush until a timer is
        // pending again before expiring it.
        await act(async () => {
            for (let drained = 0; drained < 200 && clock.pendingSleeps() === 0; drained += 1) {
                await Promise.resolve();
            }
        });
        await act(async () => {
            clock.advanceBy(CHAT_BRIDGE_HANDSHAKE_TIMEOUT_MILLISECONDS);
        });
    }
}

/**
 * The reviewer's scenario for the P2 left open on #780: a page parked waiting
 * for the bridge must not wait forever once the bounded reconnect budget is
 * spent. This owns its Worker and a TCP proxy on a stable origin, so it can take
 * the bridge down, exhaust the budget, then bring the bridge back and complete
 * pairing — all against the real application, Chat Worker, and Runtime.
 */
test("Given a setup page whose bridge exhausts its reconnect budget, When the network returns and pairing completes, Then a visible Reconnect recovers the page and sends the first message", {
    timeout: 60_000,
}, async () => {
    const clock = new TestClock(CLOCK_ORIGIN);
    const environment = await createChatWorkerEnvironment();
    try {
        const base = await environment.createApplication(clock);
        const proxy = await createBridgeProxy(base.origin);
        const transport = new WebSocketApiTransport(proxy.origin, clock);
        transport.open();
        // The application, its transport, and the page origin all point at the
        // proxy so the Worker's bridge Origin check matches, exactly as a direct
        // connection to the Worker would.
        const application = { ...base, origin: proxy.origin, transport, close: () => transport.dispose() };
        const scope = {
            botId: base.botId,
            projectId: base.identity.projectId,
            userId: base.userId,
        };
        window.location.href = `${proxy.origin}/chat?identity=${encodeURIComponent(encodeIdentityScope(scope))}`;
        window.localStorage.setItem(
            ANONYMOUS_CREDENTIAL_KEY_NAME,
            JSON.stringify({
                ...(centralLocalStorage.read(anonymousCredentialsEntry) ?? {}),
                [base.userId]: await base.identity.getToken(new AbortController().signal),
            }),
        );
        const app = await createTestApp({ application, clock, page: { kind: "reload" } });
        try {
            // An unpaired Machine shows the setup page, which parks on a bridge
            // watch waiting for pairing.
            await app.queryElementByTestId(dataTestId.pairingInstruction);

            // Take the bridge down and spend the whole reconnect budget. The
            // parked setup watch is waiting on the bridge the entire time:
            // `drop` makes every reconnect dial stall, and `disconnect` severs
            // the live bridge so the transport starts its bounded retry.
            proxy.drop();
            app.transport.disconnect();
            await spendReconnectBudget(clock);

            // The exhausted budget ends the wait with an operable failure: the
            // inline message and a Reconnect action the user can click, instead
            // of a page stuck on setup with no way forward.
            const failure = await app.queryElementByTestId(dataTestId.sessionLoadFailure);
            expect(failure.textContent).toContain("WebSocket to Morty");
            const reconnect = getByRole(document.body, "button", { name: "Reconnect" });
            expect(reconnect).toBeInstanceOf(HTMLButtonElement);

            // The network returns and the user completes pairing locally while
            // the page is still showing the failure.
            proxy.restore();
            const daemon = await base.connectAgent();

            // The visible Reconnect re-dials, re-reads the now-paired Machine,
            // and brings the draft composer back.
            await app.user.click(reconnect);
            const composer = await app.queryElementByTestId(
                dataTestId.messageComposer,
                (element) => element instanceof HTMLTextAreaElement && !element.disabled,
            );

            // The recovered page sends its first message and the Agent answers.
            await sendPrompt(app, composer, "First message after the bridge gave up");
            await app.waitForView(() =>
                expect(agentAnswered(app, "Codex turn 1: First message after the bridge gave up")).toBe(true),
            );
            void daemon;
        } finally {
            await app.close();
            await proxy.close();
        }
    } finally {
        await environment.close();
    }
});
