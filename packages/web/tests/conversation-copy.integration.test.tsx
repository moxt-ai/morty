import { getByRole, queryByRole } from "@testing-library/dom";
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
    await app.user.click(copy);
    await app.waitForView(() => expect(getByRole(response, "status").textContent).toBe("Response copied to clipboard"));
    expect(await navigator.clipboard.readText()).toBe("Partial rich reply");
    app.remount();
    await app.user.click(await app.waitForView(() => getByRole(document.body, "button", { name: "Copy response" })));
    await app.waitForView(() => expect(getByRole(document.body, "button", { name: "Copied" })).toBeDefined());
    expect(await navigator.clipboard.readText()).toBe("Partial rich reply");
});
