import { getAllByLabelText, getByLabelText, getByRole, queryByLabelText } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

function readTool(app: TestApp, title: string) {
    const entry = app
        .elementsByTestId(dataTestId.agentToolCall)
        .find((element) => element.getAttribute("aria-label") === `Tool: ${title}`);
    if (entry === undefined) {
        throw new Error(`Tool unavailable: ${title}`);
    }
    return entry;
}
async function tool(app: TestApp, title: string) {
    return await app.waitForView(() => readTool(app, title));
}
async function assertSettled(app: TestApp) {
    for (const title of ["Unfinished verification", "Pending verification"]) {
        await app.waitForView(() => expect(getByLabelText(readTool(app, title), "Tool interrupted")).toBeDefined());
        expect(queryByLabelText(readTool(app, title), "Tool running")).toBeNull();
    }
    expect(getByLabelText(await tool(app, "Completed verification"), "Tool succeeded")).toBeDefined();
    expect(getByLabelText(await tool(app, "Failed verification"), "Tool failed")).toBeDefined();
}
async function start(prompt: string) {
    const app = await createTestApp({
        connectAgent: true,
        agent: { id: "tool-lifecycle-test", label: "Tool Lifecycle Agent" },
        page: { kind: "bootstrap", identity: true },
    });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), prompt);
    return app;
}

test("Given unfinished tools in an active turn, When the user stops it, Then every viewer sees interrupted tools and a stop notice after reload", {
    timeout: 30_000,
}, async () => {
    const app = await start("hold unfinished tools");
    expect(getByLabelText(await tool(app, "Unfinished verification"), "Tool running")).toBeDefined();
    const viewer = await app.openViewer();
    expect(getByLabelText(await tool(viewer, "Unfinished verification"), "Tool running")).toBeDefined();
    await app.user.click(
        await app.queryElementByTestId(
            dataTestId.sendMessage,
            (element) => element.getAttribute("aria-label") === "Stop agent output",
        ),
    );
    for (const current of [app, viewer]) {
        await assertSettled(current);
        expect((await current.queryElementByTestId(dataTestId.agentReplyStatus)).textContent).toContain(
            "Turn stopped.",
        );
    }
    await viewer.close();
    const reloaded = await app.reload();
    await assertSettled(reloaded);
    expect((await reloaded.queryElementByTestId(dataTestId.agentReplyStatus)).textContent).toContain("Turn stopped.");
});

for (const prompt of ["fail unfinished tools", "complete unfinished tools"]) {
    test(`Given unfinished tools, When the agent returns ${prompt}, Then terminal tool outcomes are preserved and unfinished tools become interrupted`, {
        timeout: 30_000,
    }, async () => {
        const app = await start(prompt);
        await assertSettled(app);
        const reloaded = await app.reload();
        await assertSettled(reloaded);
        await sendPrompt(
            reloaded,
            await reloaded.queryElementByTestId(dataTestId.messageComposer),
            "hold unfinished tools",
        );
        await reloaded.waitForView(() => expect(getAllByLabelText(document.body, "Tool running")).toHaveLength(2));
        expect(getAllByLabelText(document.body, "Tool interrupted")).toHaveLength(2);
        await reloaded.user.click(
            await reloaded.queryElementByTestId(
                dataTestId.sendMessage,
                (element) => element.getAttribute("aria-label") === "Stop agent output",
            ),
        );
        await reloaded.waitForView(() => expect(getAllByLabelText(document.body, "Tool interrupted")).toHaveLength(4));
    });
}

test("Given a stopped tool starts on an older history page, When the user loads that page, Then it remains interrupted and the stop notice is not duplicated", {
    timeout: 60_000,
}, async () => {
    const app = await start("hold tools across history pages");
    await app.waitForView(() => expect(document.body.textContent).toContain("Progress item 249"));
    await app.user.click(
        await app.queryElementByTestId(
            dataTestId.sendMessage,
            (element) => element.getAttribute("aria-label") === "Stop agent output",
        ),
    );
    await app.queryElementByTestId(dataTestId.agentReplyStatus);
    const reloaded = await app.reload();
    await reloaded.queryElementByTestId(dataTestId.agentReplyStatus);
    for (let page = 0; page < 10; page += 1) {
        if (reloaded.elementsByTestId(dataTestId.agentToolCall).length === 4) {
            break;
        }
        const before = reloaded.elementsByTestId(dataTestId.agentResponse).length;
        await reloaded.user.click(
            await reloaded.waitForView(() => getByRole(document.body, "button", { name: "Load older messages" })),
        );
        await reloaded.waitForView(() =>
            expect(
                reloaded.elementsByTestId(dataTestId.agentResponse).length +
                    reloaded.elementsByTestId(dataTestId.agentToolCall).length,
            ).toBeGreaterThan(before),
        );
    }
    await assertSettled(reloaded);
    expect(reloaded.elementsByTestId(dataTestId.agentReplyStatus)).toHaveLength(1);
});
