import { fireEvent, getByRole, queryByRole } from "@testing-library/dom";
import { flushSync } from "react-dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

function setScrollMetrics(
    element: HTMLElement,
    metrics: { readonly clientHeight: number; readonly scrollHeight: number },
) {
    Object.defineProperties(element, {
        clientHeight: { configurable: true, get: () => metrics.clientHeight },
        scrollHeight: { configurable: true, get: () => metrics.scrollHeight },
    });
}

function scrollAwayFromLatest(
    element: HTMLElement,
    metrics: { readonly clientHeight: number; readonly scrollHeight: number },
    scrollTop: number,
) {
    setScrollMetrics(element, metrics);
    // Establish the rendered bottom as the starting point so the next event
    // represents the user's real upward wheel gesture.
    element.scrollTop = metrics.scrollHeight - metrics.clientHeight;
    flushSync(() => fireEvent.scroll(element));
    element.scrollTop = scrollTop;
    flushSync(() => fireEvent.scroll(element));
}

test("Given a long conversation scrolled away from its latest message, When the user activates Jump to latest message, Then Chat returns to the bottom", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, "scroll to latest");
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Codex turn 1: scroll to latest")),
        ).toBe(true),
    );
    const messages = await app.waitForView(() => getByRole(document.body, "log", { name: "Messages" }));
    scrollAwayFromLatest(messages, { clientHeight: 400, scrollHeight: 1_200 }, 300);
    const jump = await app.waitForView(() => {
        const element = getByRole(document.body, "button", { name: "Jump to latest message" });
        if (element.getAttribute("aria-hidden") === "true") {
            throw new Error("Expected visible jump button");
        }
        return element;
    });
    await app.user.click(jump);

    await app.waitForView(() => {
        expect(messages.scrollTop).toBe(1_200);
        expect(queryByRole(document.body, "button", { name: "Jump to latest message" })).toBeNull();
    });
});

test("Given an Agent is working while the latest message is out of view, When the user reads the jump control, Then it shows the existing three-dot loading wave with a hover-only arrow", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a controlled Agent Runtime");
    }
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "wait for steering");
    await app.queryElementByTestId(dataTestId.sessionStatus);
    const messages = await app.waitForView(() => getByRole(document.body, "log", { name: "Messages" }));
    scrollAwayFromLatest(messages, { clientHeight: 400, scrollHeight: 1_200 }, 300);
    const jump = await app.waitForView(() => {
        const element = getByRole(document.body, "button", { name: "Jump to latest message while Agent is working" });
        if (element.getAttribute("aria-hidden") === "true") {
            throw new Error("Expected visible jump button while the Agent is working");
        }
        return element;
    });
    expect(jump.querySelectorAll("[data-loading-dot]")).toHaveLength(3);
    const arrow = jump.querySelector("svg");
    expect(arrow).not.toBeNull();
    expect(arrow?.classList.contains("hidden")).toBe(true);
    await daemon.continueReply("wait for steering", { outcome: "complete", output: [] });
});

test("Given the latest message is more than one dot below the viewport, When a layout update follows a wheel scroll, Then Chat does not snap back to the bottom", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, "preserve reading position");
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Codex turn 1: preserve reading position")),
        ).toBe(true),
    );
    const messages = await app.waitForView(() => getByRole(document.body, "log", { name: "Messages" }));
    scrollAwayFromLatest(messages, { clientHeight: 400, scrollHeight: 1_200 }, 300);
    await app.waitForView(() => {
        const element = getByRole(document.body, "button", { name: "Jump to latest message" });
        if (element.getAttribute("aria-hidden") === "true") {
            throw new Error("Expected visible jump button before scrolling back down");
        }
        return element;
    });
    messages.scrollTop = 740;
    flushSync(() => fireEvent.scroll(messages));
    expect(messages.scrollTop).toBe(740);
});
