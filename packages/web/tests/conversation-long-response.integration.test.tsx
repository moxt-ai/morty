import { queryAllByRole, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

async function startLongResponse(text: string) {
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a controlled Agent Runtime");
    }
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected composer");
    }
    await sendPrompt(app, composer, "hold after first delta");
    await app.waitForView(() => expect(document.body.textContent).toContain("Partial reply"));
    await daemon.continueReply("hold after first delta", {
        outcome: "hold",
        output: [{ kind: "text", text }],
    });
    return { app, daemon };
}

async function loadEntireResponse(app: Awaited<ReturnType<typeof createTestApp>>) {
    while (true) {
        const button = queryAllByRole(document.body, "button", { name: "Load more text" })[0];
        if (button === undefined) {
            return;
        }
        await app.user.click(button);
    }
}

test("Given a Markdown response over 32 KiB, When output grows and I load more, Then the preview stays bounded and renders as plain text", {
    timeout: 30_000,
}, async () => {
    const lines = Array.from({ length: 900 }, (_, index) => `> const entry_${index} = "${"x".repeat(60)}";`).join("\n");
    const { app, daemon } = await startLongResponse(
        `\n\n## Configuration\n\n> Quoted configuration\n>\n> \`\`\`typescript\n${lines}\n> \`\`\`\n\n## Finished\n\nLATEST_OUTPUT`,
    );
    await app.waitForView(() => {
        expect(queryAllByRole(document.body, "button", { name: "Load more text" }).length).toBeGreaterThan(0);
        expect(queryByRole(document.body, "heading", { name: "Configuration" })).toBeNull();
        expect(document.body.textContent).toContain("## Configuration");
        expect(document.body.textContent).toContain("```typescript");
        expect(document.body.textContent).toContain("LATEST_OUTPUT");
        expect(document.body.textContent?.match(/x/gu)?.length ?? 0).toBeLessThan(64_000);
        expect(document.body.textContent).toContain("Latest output (text preview)");
    });
    await daemon.continueReply("hold after first delta", {
        outcome: "hold",
        output: [{ kind: "text", text: "\nNEW_LIVE_OUTPUT" }],
    });
    await app.waitForView(() => expect(document.body.textContent).toContain("NEW_LIVE_OUTPUT"));
    await loadEntireResponse(app);
    await app.waitForView(() => {
        const response = Array.from(document.querySelectorAll("article")).find((article) =>
            article.textContent?.includes("## Configuration"),
        );
        if (response === undefined) {
            throw new Error("Expected the configuration response");
        }
        expect(response.querySelector("blockquote")).toBeNull();
        expect(response.querySelector("code")).toBeNull();
        expect(queryByRole(response, "heading", { name: "Finished" })).toBeNull();
        expect(response.textContent).toContain("```typescript");
        expect(response.textContent).toContain('const entry_899 = "');
        expect(response.textContent?.match(/x{60}/gu)).toHaveLength(900);
        expect(response.textContent).not.toContain("Latest output (text preview)");
    });
    await daemon.continueReply("hold after first delta", { outcome: "complete", output: [] });
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    expect(document.body.textContent).toContain("NEW_LIVE_OUTPUT");
});
