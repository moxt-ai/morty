import { getAllByRole, getByLabelText, getByRole, getByText, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

function responseWithText(text: string): HTMLElement {
    const response = getAllByRole(document.body, "article", { name: "Agent response" }).find((article) =>
        article.textContent?.includes(text),
    );
    if (response === undefined) {
        throw new Error(`Missing response: ${text}`);
    }
    return response;
}

test("Given progress prose and a streaming final answer, When the turn finishes and another starts, Then only the final answer is copyable and its Markdown survives reopening", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    if (app.daemon === null) {
        throw new Error("Expected a controlled Agent Runtime");
    }
    const prompt = "Review the execution summary behavior";
    const introduction = "I'll review the implementation and check the interactions.";
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), prompt);
    await app.waitForView(() => getByRole(document.body, "button", { name: "Show execution details" }));
    expect(queryByRole(responseWithText(introduction), "button", { name: "Copy response" })).toBeNull();
    const markdown = "## Result\n\n- **Ready**: [details](https://example.com)\n\n```ts\nconst value = 42;\n```";
    await app.daemon.continueReply(prompt, { outcome: "hold", output: [{ kind: "text", text: markdown }] });
    await app.waitForView(() => responseWithText("Result"));
    expect(queryByRole(document.body, "button", { name: "Copy response" })).toBeNull();
    await app.daemon.continueReply(prompt, { outcome: "complete", output: [{ kind: "text", text: "\n\nVerified." }] });
    const answer = await app.waitForView(() => responseWithText("Verified."));
    await app.user.click(await app.waitForView(() => getByRole(answer, "button", { name: "Copy response" })));
    await app.waitForView(() => expect(getByRole(answer, "status").textContent).toBe("Response copied to clipboard"));
    expect(await navigator.clipboard.readText()).toBe(`${markdown}\n\nVerified.`);
    expect(queryByRole(responseWithText(introduction), "button", { name: "Copy response" })).toBeNull();

    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "wait for steering");
    await app.waitForView(() => responseWithText("Waiting for steering"));
    expect(queryByRole(responseWithText("Waiting for steering"), "button", { name: "Copy response" })).toBeNull();
    expect(getByRole(answer, "button", { name: /^(Copy response|Copied)$/ })).toBeDefined();
    app.remount();
    const restored = await app.waitForView(() => responseWithText("Verified."));
    await app.user.click(getByRole(restored, "button", { name: "Copy response" }));
    await app.waitForView(() => expect(getByRole(restored, "status").textContent).toBe("Response copied to clipboard"));
    expect(await navigator.clipboard.readText()).toBe(`${markdown}\n\nVerified.`);
    expect(queryByRole(responseWithText(introduction), "button", { name: "Copy response" })).toBeNull();
    expect(queryByRole(responseWithText("Waiting for steering"), "button", { name: "Copy response" })).toBeNull();
});

test("Given progress prose followed only by tool calls, When the turn ends without an answer, Then progress is not promoted to a copyable final response", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    if (app.daemon === null) {
        throw new Error("Expected a controlled Agent Runtime");
    }
    const prompt = "Review the execution summary behavior";
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), prompt);
    await app.waitForView(() => getByRole(document.body, "button", { name: "Show execution details" }));
    await app.daemon.continueReply(prompt, { outcome: "complete", output: [] });
    await app.waitForView(() => getByText(document.body, "Operations complete"));
    expect(queryByRole(document.body, "button", { name: "Copy response" })).toBeNull();
    app.remount();
    await app.waitForView(() => getByText(document.body, "Operations complete"));
    expect(queryByRole(document.body, "button", { name: "Copy response" })).toBeNull();
});

test("Given an unfinished response, When I steer the running turn and stop it, Then only the latest retained response becomes copyable", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "wait for steering");
    await app.waitForView(() => responseWithText("Waiting for steering"));
    const instruction = "Use the revised requirement";
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), instruction);
    const queued = await app.queryElementByTestId(dataTestId.queuedMessage);
    await app.user.click(getByLabelText(queued, `Steer queued message: ${instruction}`));
    await app.waitForView(() => responseWithText(`Steered: ${instruction}`));
    expect(queryByRole(document.body, "button", { name: "Copy response" })).toBeNull();
    await app.user.click(getByRole(document.body, "button", { name: "Stop agent output" }));
    const retained = responseWithText(`Steered: ${instruction}`);
    await app.user.click(await app.waitForView(() => getByRole(retained, "button", { name: "Copy response" })));
    await app.waitForView(() => expect(getByRole(retained, "status").textContent).toBe("Response copied to clipboard"));
    expect(await navigator.clipboard.readText()).toBe(`Steered: ${instruction}`);
    expect(queryByRole(responseWithText("Waiting for steering"), "button", { name: "Copy response" })).toBeNull();
});

test("Given a streaming response, When I stop the agent, Then I can copy the retained answer and copy it again after reopening the chat", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, "hold with rich content");
    const response = await app.waitForView(() => getByRole(document.body, "article", { name: "Agent response" }));
    expect(queryByRole(response, "button", { name: "Copy response" })).toBeNull();
    await app.user.click(
        await app.waitForView(() => getByRole(document.body, "button", { name: "Stop agent output" })),
    );
    const copy = await app.waitForView(() => getByRole(response, "button", { name: "Copy response" }));
    await app.user.click(copy);
    await app.waitForView(() => expect(getByRole(response, "status").textContent).toBe("Response copied to clipboard"));
    expect(await navigator.clipboard.readText()).toBe("Partial rich reply");
    app.remount();
    await app.user.click(await app.waitForView(() => getByRole(document.body, "button", { name: "Copy response" })));
    await app.waitForView(() => expect(getByRole(document.body, "button", { name: "Copied" })).toBeDefined());
    expect(await navigator.clipboard.readText()).toBe("Partial rich reply");
});
