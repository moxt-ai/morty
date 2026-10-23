import { createServer } from "node:http";
import { close as closeSentry, init, makeFetchTransport } from "@sentry/react";
import { getAllByRole, getByLabelText, getByRole, queryByRole } from "@testing-library/dom";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WebSocketApiTransport } from "../src/services/api/websocket-api-transport.ts";
import { createMortyApplication } from "../src/view-models/morty-application.ts";
import { App } from "../src/views/application/app.tsx";
import { createTestApp } from "./infra/test-app.tsx";

/**
 * A dependency-injected transport that touches nothing: measurements and
 * requests degrade instead of reaching the network.
 */
/**
 * A real transport pointed at an unreachable origin and never opened: every
 * operation fails on its own, so measurements and requests degrade instead of
 * reaching the network.
 */
function noopTransport(): WebSocketApiTransport {
    return new WebSocketApiTransport("http://127.0.0.1:1");
}

const observers = new Set<MutationObserver>();
const pngBytes = Uint8Array.from(
    atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOuoAAAAASUVORK5CYII="),
    (char) => char.charCodeAt(0),
);
beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T08:00:00Z"));
});
afterEach(() => {
    for (const observer of observers) {
        observer.disconnect();
    }
    observers.clear();
    cleanup();
    vi.useRealTimers();
});

test("Given the report dialog is open, When a user pastes and selects images and removes one, Then Sentry receives only the remaining image with the description and diagnostics", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T08:00:00Z"));
    const inbox = await createReportInbox();
    try {
        render(
            <App
                bugReportDialog={
                    createMortyApplication({ origin: window.location.origin, transport: noopTransport() })
                        .bugReportDialog
                }
                state={{ kind: "failed", retry: () => window.location.reload() }}
            />,
        );
        const user = userEvent.setup();
        await user.click(getByRole(document.body, "button", { name: "Report a bug" }));
        const description = getByRole(document.body, "textbox", { name: "What went wrong?" });
        await user.type(description, "The layout is broken");
        const clipboard = new DataTransfer();
        clipboard.items.add(new File([pngBytes], "pasted.png", { type: "image/png" }));
        await user.paste(clipboard);
        expect(getByRole(document.body, "img", { name: "pasted.png" })).toBeDefined();
        await user.upload(
            getByLabelText(document.body, "Attach images"),
            new File([pngBytes], "selected.png", { type: "image/png" }),
        );
        expect(getByRole(document.body, "img", { name: "selected.png" })).toBeDefined();
        await user.click(getByRole(document.body, "button", { name: "Remove selected.png" }));
        expect(queryByRole(document.body, "img", { name: "selected.png" })).toBeNull();
        expect(inbox.envelopes).toHaveLength(0);
        await user.click(getByRole(document.body, "button", { name: "Send report" }));
        await visibleMessage(document.body, "status", "Report sent");
        expect(inbox.envelopes).toHaveLength(1);
        const envelope = inbox.envelopes[0] ?? "";
        expect(envelope).toContain('"description":"The layout is broken"');
        expect(envelope).toContain('"filename":"diagnostics.json"');
        expect(envelope).toContain('"filename":"image-1.png"');
        expect(envelope).toContain('"content_type":"image/png"');
        expect(envelope).not.toContain('"filename":"image-2.png"');
        expect(inbox.bodies[0]?.includes(Buffer.from(pngBytes))).toBe(true);
    } finally {
        await inbox.close();
        vi.useRealTimers();
    }
});

test.each([
    { name: "an unsupported file", type: "image/svg+xml", size: 20, count: 1, error: "Only PNG, JPEG, GIF, and WebP" },
    { name: "an oversized image", type: "image/png", size: 2_500_001, count: 1, error: "between 1 byte and 2.5 MB" },
    { name: "an empty image", type: "image/png", size: 0, count: 1, error: "between 1 byte and 2.5 MB" },
    { name: "too many images", type: "image/png", size: 20, count: 4, error: "up to 3 images" },
])(
    "Given the report dialog is open, When the user pastes $name, Then an actionable error appears without uploading it",
    async ({ type, size, count, error }) => {
        const inbox = await createReportInbox();
        try {
            render(
                <App
                    bugReportDialog={
                        createMortyApplication({ origin: window.location.origin, transport: noopTransport() })
                            .bugReportDialog
                    }
                    state={{ kind: "failed", retry: () => window.location.reload() }}
                />,
            );
            const user = userEvent.setup();
            await user.click(getByRole(document.body, "button", { name: "Report a bug" }));
            await user.click(getByRole(document.body, "textbox", { name: "What went wrong?" }));
            await user.paste("The layout is broken");
            const clipboard = new DataTransfer();
            for (let index = 0; index < count; index += 1) {
                clipboard.items.add(new File([new Uint8Array(size)], `invalid-${index}.png`, { type }));
            }
            await user.paste(clipboard);
            const dialog = getByRole(document.body, "dialog");
            expect(getByRole(dialog, "alert").textContent).toContain(error);
            expect(queryByRole(dialog, "list", { name: "Attached images" })).toBeNull();
            expect(inbox.envelopes).toHaveLength(0);
            await user.click(getByRole(dialog, "button", { name: "Send report" }));
            await visibleMessage(dialog, "status", "Report sent");
            expect(inbox.envelopes[0]).toContain('"description":"The layout is broken"');
            expect(inbox.envelopes[0]).not.toContain('"content_type":"image/');
        } finally {
            await inbox.close();
        }
    },
);

test("Given a file claims to be a PNG, When its contents do not match and the user submits it, Then the report is rejected locally and can be sent after removing the image", async () => {
    const inbox = await createReportInbox();
    try {
        render(
            <App
                bugReportDialog={
                    createMortyApplication({ origin: window.location.origin, transport: noopTransport() })
                        .bugReportDialog
                }
                state={{ kind: "failed", retry: () => window.location.reload() }}
            />,
        );
        const user = userEvent.setup();
        await user.click(getByRole(document.body, "button", { name: "Report a bug" }));
        await user.type(getByRole(document.body, "textbox", { name: "What went wrong?" }), "The layout is broken");
        await user.upload(
            getByLabelText(document.body, "Attach images"),
            new File(["not an image"], "invalid.png", { type: "image/png" }),
        );
        await user.click(getByRole(document.body, "button", { name: "Send report" }));
        const dialog = getByRole(document.body, "dialog");
        await visibleMessage(dialog, "alert", "does not match");
        expect(inbox.envelopes).toHaveLength(0);
        await user.click(getByRole(dialog, "button", { name: "Remove invalid.png" }));
        await user.click(getByRole(dialog, "button", { name: "Send report" }));
        await visibleMessage(dialog, "status", "Report sent");
        expect(inbox.envelopes).toHaveLength(1);
    } finally {
        await inbox.close();
    }
});
function visibleMessage(container: HTMLElement, role: "status" | "alert", text: string): Promise<HTMLElement> {
    return new Promise((resolve) => {
        const check = () => {
            const element = queryByRole(container, role);
            if (element?.textContent?.includes(text) === true) {
                observer.disconnect();
                observers.delete(observer);
                resolve(element);
            }
        };
        const observer = new MutationObserver(check);
        observers.add(observer);
        observer.observe(container, { childList: true, subtree: true, characterData: true });
        check();
    });
}

// Stateful Sentry peer at its HTTP ingestion boundary, with the real browser SDK.
async function createReportInbox() {
    const envelopes: string[] = [];
    const bodies: Buffer[] = [];
    let status = 200;
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
        }
        if (request.method === "POST" && status === 200) {
            const body = Buffer.concat(chunks);
            bodies.push(body);
            envelopes.push(body.toString("utf8"));
        }
        response
            .writeHead(request.method === "OPTIONS" ? 200 : status, {
                "content-type": "application/json",
                "access-control-allow-origin": "*",
                "access-control-allow-methods": "POST, OPTIONS",
                "access-control-allow-headers": "content-type, sentry-trace, baggage",
            })
            .end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("The report inbox did not listen");
    }
    init({
        dsn: `http://public@127.0.0.1:${address.port}/1`,
        defaultIntegrations: false,
        sendClientReports: false,
        transport: (options) => makeFetchTransport(options, window.fetch.bind(window)),
    });
    return {
        envelopes,
        bodies,
        accept: (next: number) => {
            status = next;
        },
        close: async () => {
            await closeSentry();
            await new Promise<void>((resolve, reject) => server.close((cause) => (cause ? reject(cause) : resolve())));
        },
    };
}

test("Given Morty cannot load and no daemon is connected, When a user reports a bug, Then Sentry receives the description and available diagnostics and the user sees a report number", async () => {
    const inbox = await createReportInbox();
    try {
        render(
            <App
                bugReportDialog={
                    createMortyApplication({ origin: window.location.origin, transport: noopTransport() })
                        .bugReportDialog
                }
                state={{ kind: "failed", retry: () => window.location.reload() }}
            />,
        );
        const user = userEvent.setup();
        await user.click(getByRole(document.body, "button", { name: "Report a bug" }));
        await user.type(
            getByRole(document.body, "textbox", { name: "What went wrong?" }),
            "The conversation never opened",
        );
        await user.click(getByRole(document.body, "button", { name: "Send report" }));
        const confirmation = await visibleMessage(document.body, "status", "Report sent");
        expect(confirmation.textContent).toContain("Report sent. Reference:");
        expect(confirmation.textContent).toContain("Daemon diagnostics were unavailable");
        expect(inbox.envelopes).toHaveLength(1);
        const envelope = inbox.envelopes[0] ?? "";
        expect(envelope).toContain('"type":"feedback"');
        expect(envelope).toContain('"filename":"diagnostics.json"');
        expect(envelope).toContain('"description":"The conversation never opened"');
        expect(envelope).toContain('"code":"NO_ACTIVE_RUNTIME"');
        const report = JSON.parse(envelope.trim().split("\n").at(-1) ?? "null");
        expect(report.network).toMatchObject({
            online: navigator.onLine,
            measurements: {
                browserMorty: { kind: "unavailable", code: "CHAT_CONNECTION_LOST" },
                browserMobius: { kind: "unavailable", code: "NO_ACTIVE_RUNTIME" },
            },
        });
        expect(report.network).not.toHaveProperty("vpn");
        expect(report.network).not.toHaveProperty("proxy");
        expect(getByRole(document.body, "button", { name: "Close dialog" })).toBeDefined();
    } finally {
        await inbox.close();
    }
});

test("Given Sentry rejects a report, When the user retries after it recovers, Then the description is preserved and a report can be sent", async () => {
    const inbox = await createReportInbox();
    try {
        inbox.accept(503);
        render(
            <App
                bugReportDialog={
                    createMortyApplication({ origin: window.location.origin, transport: noopTransport() })
                        .bugReportDialog
                }
                state={{ kind: "failed", retry: () => window.location.reload() }}
            />,
        );
        const user = userEvent.setup();
        await user.click(getByRole(document.body, "button", { name: "Report a bug" }));
        await user.type(getByRole(document.body, "textbox", { name: "What went wrong?" }), "My message disappeared");
        await user.upload(
            getByLabelText(document.body, "Attach images"),
            new File([pngBytes], "retry.png", { type: "image/png" }),
        );
        await user.click(getByRole(document.body, "button", { name: "Send report" }));
        // The application already has its startup error; the dialog owns the report error.
        const dialog = getByRole(document.body, "dialog");
        expect((await visibleMessage(dialog, "alert", "not accepted")).textContent).toContain("not accepted");
        expect(getByRole(dialog, "img", { name: "retry.png" })).toBeDefined();
        inbox.accept(200);
        await user.click(getByRole(dialog, "button", { name: "Send report" }));
        expect((await visibleMessage(dialog, "status", "Report sent")).textContent).toContain("Report sent");
        expect(inbox.envelopes).toHaveLength(1);
        expect(inbox.envelopes[0]).toContain("My message disappeared");
        expect(inbox.bodies[0]?.includes(Buffer.from(pngBytes))).toBe(true);
    } finally {
        await inbox.close();
    }
});

test("Given a native handoff cannot find its Agent, When the user reports the displayed error, Then the report includes its code and attempts daemon diagnostics for that Machine", {
    timeout: 30_000,
}, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-10T07:21:00Z"));
    const inbox = await createReportInbox();
    try {
        const app = await createTestApp({ page: { kind: "continue", harness: "pi", sessionId: "native-session" } });
        await app.waitForView(() => {
            expect(getByRole(document.body, "alert").textContent).toContain("handoff harness is unavailable");
        });
        await app.user.click(getByRole(document.body, "button", { name: "Report a bug" }));
        await app.user.type(getByRole(document.body, "textbox", { name: "What went wrong?" }), "Cannot continue Pi");
        await app.user.click(getByRole(document.body, "button", { name: "Send report" }));
        await visibleMessage(document.body, "status", "Report sent");
        const envelope = inbox.envelopes[0] ?? "";
        const report = JSON.parse(envelope.trim().split("\n").at(-1) ?? "null");
        expect(report).toMatchObject({
            botId: app.botId,
            sessionId: null,
            nativeSessionId: "native-session",
            daemon: { kind: "unavailable", code: "AGENT_REQUIRED" },
            network: {
                measurements: {
                    browserMorty: { kind: "available", latencyMs: expect.any(Number) },
                    mobiusDaemon: { kind: "unavailable" },
                },
            },
        });
        expect(report.web.entries).toContainEqual(
            expect.objectContaining({
                component: "web",
                operation: "continue-native-session",
                outcome: "HARNESS_UNAVAILABLE",
                requestId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
            }),
        );
        expect(envelope).not.toContain("The handoff harness is unavailable.");
        await app.close();
        render(
            <App
                bugReportDialog={
                    createMortyApplication({ origin: window.location.origin, transport: noopTransport() })
                        .bugReportDialog
                }
                state={{ kind: "failed", retry: () => window.location.reload() }}
            />,
        );
        const user = userEvent.setup();
        await user.click(getByRole(document.body, "button", { name: "Report a bug" }));
        await user.type(getByRole(document.body, "textbox", { name: "What went wrong?" }), "Another page failed");
        await user.click(getByRole(document.body, "button", { name: "Send report" }));
        await visibleMessage(document.body, "status", "Report sent");
        const afterUnmount = JSON.parse((inbox.envelopes[1] ?? "").trim().split("\n").at(-1) ?? "null");
        expect(afterUnmount).toMatchObject({
            botId: null,
            sessionId: null,
            daemon: { kind: "unavailable", code: "NO_ACTIVE_RUNTIME" },
        });
    } finally {
        await inbox.close();
        vi.useRealTimers();
    }
});

test("Given a connected Runtime, When the user reports a bug, Then the report automatically includes each network hop without asking about their network", {
    timeout: 30_000,
}, async () => {
    const inbox = await createReportInbox();
    try {
        const app = await createTestApp({ connectAgent: true });
        // The chat page's sidebar button, not the floating trigger the
        // loading page shows before the anonymous session resolves.
        await app.waitForView(() => {
            if (document.querySelector('main[aria-label="Chat"]') === null) {
                throw new Error("The chat page did not appear.");
            }
            return getByRole(document.body, "button", { name: "Report a bug" });
        });
        await app.user.click(getByRole(document.body, "button", { name: "Report a bug" }));
        const dialog = getByRole(document.body, "dialog", { name: "Report a bug" });
        expect(queryByRole(dialog, "combobox")).toBeNull();
        expect(getAllByRole(dialog, "textbox")).toHaveLength(1);
        await app.user.type(getByRole(dialog, "textbox", { name: "What went wrong?" }), "My connection stalled");
        await app.user.click(getByRole(dialog, "button", { name: "Send report" }));
        await visibleMessage(dialog, "status", "Report sent");
        const report = JSON.parse((inbox.envelopes[0] ?? "").trim().split("\n").at(-1) ?? "null");
        expect(report.network).toMatchObject({
            online: navigator.onLine,
            measurements: {
                browserMorty: { kind: "available", latencyMs: expect.any(Number) },
                browserMobius: { kind: "available", latencyMs: expect.any(Number) },
                mortyMobius: { kind: "available", latencyMs: expect.any(Number) },
                mobiusDaemon: { kind: "available", latencyMs: expect.any(Number) },
            },
        });
        expect(report.web.entries).toContainEqual(
            expect.objectContaining({
                component: "worker",
                operation: "connection",
                outcome: "connected",
                elapsedMs: expect.any(Number),
            }),
        );
        expect(JSON.stringify(report.network)).not.toContain("http");
        expect(report.network).not.toHaveProperty("vpn");
        expect(report.network).not.toHaveProperty("proxy");
    } finally {
        await inbox.close();
    }
});

test("Given two Runtime views are mounted, When a user reports from the first view, Then diagnostics identify that view's Runtime instead of the last mounted Runtime", {
    timeout: 30_000,
}, async () => {
    const inbox = await createReportInbox();
    try {
        const first = await createTestApp({ connectAgent: true });
        const reportButton = await first.waitForView(() => {
            if (document.querySelector('main[aria-label="Chat"]') === null) {
                throw new Error("The chat page did not appear.");
            }
            return getByRole(document.body, "button", { name: "Report a bug" });
        });
        const second = await createTestApp({ connectAgent: true });
        await second.waitForView(() =>
            expect(getAllByRole(document.body, "button", { name: "Report a bug" })).toHaveLength(2),
        );
        await first.user.click(reportButton);
        const dialog = getByRole(document.body, "dialog", { name: "Report a bug" });
        await first.user.type(getByRole(dialog, "textbox", { name: "What went wrong?" }), "The first Runtime is slow");
        await first.user.click(getByRole(dialog, "button", { name: "Send report" }));
        await visibleMessage(dialog, "status", "Report sent");
        const report = JSON.parse((inbox.envelopes[0] ?? "").trim().split("\n").at(-1) ?? "null");
        expect(report.botId).toBe(first.botId);
        expect(report.botId).not.toBe(second.botId);
        expect(report.daemon.kind).toBe("available");
        expect(report.network.measurements.mobiusDaemon.kind).toBe("available");
    } finally {
        await inbox.close();
    }
});
