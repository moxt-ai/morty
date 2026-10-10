import { createServer } from "node:http";
import { close as closeSentry, init, makeFetchTransport } from "@sentry/react";
import { getByRole, queryByRole } from "@testing-library/dom";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "../src/views/application/app.tsx";
import { createTestApp } from "./infra/test-app.tsx";

const observers = new Set<MutationObserver>();
afterEach(() => {
    for (const observer of observers) {
        observer.disconnect();
    }
    observers.clear();
    cleanup();
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
    let status = 200;
    const server = createServer(async (request, response) => {
        let content = "";
        for await (const chunk of request) {
            content += String(chunk);
        }
        if (request.method === "POST" && status === 200) {
            envelopes.push(content);
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
        render(<App state={{ kind: "failed" }} />);
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
        expect(getByRole(document.body, "button", { name: "Close dialog" })).toBeDefined();
    } finally {
        await inbox.close();
    }
});

test("Given Sentry rejects a report, When the user retries after it recovers, Then the description is preserved and a report can be sent", async () => {
    const inbox = await createReportInbox();
    try {
        inbox.accept(503);
        render(<App state={{ kind: "failed" }} />);
        const user = userEvent.setup();
        await user.click(getByRole(document.body, "button", { name: "Report a bug" }));
        await user.type(getByRole(document.body, "textbox", { name: "What went wrong?" }), "My message disappeared");
        await user.click(getByRole(document.body, "button", { name: "Send report" }));
        // The application already has its startup error; the dialog owns the report error.
        const dialog = getByRole(document.body, "dialog");
        expect((await visibleMessage(dialog, "alert", "not accepted")).textContent).toContain("not accepted");
        inbox.accept(200);
        await user.click(getByRole(dialog, "button", { name: "Send report" }));
        expect((await visibleMessage(dialog, "status", "Report sent")).textContent).toContain("Report sent");
        expect(inbox.envelopes).toHaveLength(1);
        expect(inbox.envelopes[0]).toContain("My message disappeared");
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
        const importButton = await app.waitForView(() =>
            getByRole(document.body, "button", { name: "Import session" }),
        );
        await app.user.click(importButton);
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
        render(<App state={{ kind: "failed" }} />);
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
