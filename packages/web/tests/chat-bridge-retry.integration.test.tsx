import { expect, test } from "vitest";
import { ChatBridgeError, WebSocketApiTransport } from "../src/services/api/websocket-api-transport.ts";
import { TestClock } from "./infra/test-clock.ts";

const CLOCK_ORIGIN = "2026-10-13T08:00:00Z";
const UNREACHABLE_ORIGIN = "http://127.0.0.1:1";
const RECONNECT_DELAYS_MILLISECONDS = [1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000];

/**
 * Boundary contract for the transport: the retry budget is bounded, so callers
 * waiting for the bridge must be told when it is consumed instead of waiting
 * forever for a connection that will never arrive.
 */
test("Given a bridge that cannot reconnect, When the retry budget is consumed, Then waiting callers are told instead of waiting forever", {
    timeout: 30_000,
}, async () => {
    const clock = new TestClock(CLOCK_ORIGIN);
    const transport = new WebSocketApiTransport(UNREACHABLE_ORIGIN, clock);
    transport.open();
    const waiting = transport.waitForBridge(new AbortController().signal);
    void waiting.catch(() => undefined);
    const bridgeSettled = async (): Promise<"pending" | "settled"> =>
        await Promise.race([
            waiting.then(
                () => "settled" as const,
                () => "settled" as const,
            ),
            Promise.resolve("pending" as const),
        ]);
    transport.disconnect();
    const request = (): Request => new Request(`${UNREACHABLE_ORIGIN}/morty/api/chat/projects/p/bots/b/workspace`);

    for (const [index, delay] of RECONNECT_DELAYS_MILLISECONDS.entries()) {
        clock.advanceBy(delay);
        // Each attempt fails against the closed port; awaiting the request
        // joins the in-flight attempt and yields until it settles.
        await expect(transport.fetch(request())).rejects.toBeInstanceOf(ChatBridgeError);
        if (index < RECONNECT_DELAYS_MILLISECONDS.length - 1) {
            // The budget is still open, so waiting callers are not told yet.
            expect(await bridgeSettled()).toBe("pending");
        }
    }

    await expect(waiting).rejects.toMatchObject({ code: "bridge_unavailable" });
    await expect(transport.waitForBridge(new AbortController().signal)).rejects.toMatchObject({
        code: "bridge_unavailable",
    });
    transport.dispose();
});
