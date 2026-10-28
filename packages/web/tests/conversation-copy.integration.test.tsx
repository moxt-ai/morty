import { getAllByRole, getByRole, getByText, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

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
    expect(
        getAllByRole(response, "button", {
            name: /Copy (?:response|code|shell output|command|diagram source)|Copied/u,
        }),
    ).toHaveLength(1);
    await app.user.click(copy);
    await app.waitForView(() => expect(getByText(response, "Response copied to clipboard")).toBeDefined());
    expect(await navigator.clipboard.readText()).toBe("Partial rich reply");
    app.remount();
    const restored = await app.waitForView(() => getByRole(document.body, "article", { name: "Agent response" }));
    await app.user.click(getByRole(restored, "button", { name: "Copy response" }));
    await app.waitForView(() => expect(getByRole(restored, "button", { name: "Copied" })).toBeDefined());
    expect(await navigator.clipboard.readText()).toBe("Partial rich reply");
});

test("Given a settled response with copyable rich parts and ordinary tool output, When I copy the response, Then one button copies Markdown, Shell output, and no ordinary tool text", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a controlled Agent Runtime");
    }
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, "hold with rich content");
    const markdown = "\n\n## Result\n\n```ts\nconst value = 42;\n```";
    await daemon.continueReply("hold with rich content", {
        outcome: "complete",
        output: [
            { kind: "text", text: markdown },
            {
                activityType: "tool",
                content: [],
                kind: "activity",
                output: "ORDINARY_TOOL_OUTPUT",
                title: "Ordinary tool",
            },
            {
                activityType: "tool",
                content: [],
                kind: "activity",
                output: JSON.stringify({
                    exitCode: 0,
                    output: "\u001B[31mfailed\u001B[0m\n\u001B[1;32mpassed\u001B[0m",
                }),
                title: '/bin/zsh -lc "pnpm test"',
            },
        ],
    });
    const response = await app.waitForView(() => getByRole(document.body, "article", { name: "Agent response" }));
    const copy = await app.waitForView(() => getByRole(response, "button", { name: "Copy response" }));
    expect(
        getAllByRole(response, "button", {
            name: /Copy (?:response|code|shell output|command|diagram source)|Copied/u,
        }),
    ).toHaveLength(1);
    expect(queryByRole(response, "button", { name: "Copy code" })).toBeNull();
    expect(queryByRole(response, "button", { name: "Copy shell output" })).toBeNull();
    await app.user.click(copy);
    await app.waitForView(() => expect(getByText(response, "Response copied to clipboard")).toBeDefined());
    expect(await navigator.clipboard.readText()).toBe(`${markdown}\n\nPartial rich reply\n\nfailed\npassed`);
});
