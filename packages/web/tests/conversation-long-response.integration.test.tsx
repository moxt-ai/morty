import { getByRole, queryByRole } from "@testing-library/dom";
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
        (element) => element.textContent?.includes("Connected") === true,
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
    while (queryByRole(document.body, "button", { name: "Load more text" }) !== null) {
        await app.user.click(getByRole(document.body, "button", { name: "Load more text" }));
    }
}

test("Given a long quoted code block, When output grows and I load more, Then the preview stays bounded and the expanded response keeps its original structure", {
    timeout: 30_000,
}, async () => {
    const lines = Array.from({ length: 900 }, (_, index) => `> const entry_${index} = "${"x".repeat(60)}";`).join("\n");
    const { app, daemon } = await startLongResponse(
        `\n\n## Configuration\n\n> Quoted configuration\n>\n> \`\`\`typescript\n${lines}\n> \`\`\`\n\n## Finished\n\nLATEST_OUTPUT`,
    );
    await app.waitForView(() => {
        expect(getByRole(document.body, "button", { name: "Load more text" })).toBeDefined();
        expect(getByRole(document.body, "heading", { name: "Configuration" })).toBeDefined();
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
        const response = getByRole(document.body, "heading", { name: "Configuration" }).closest("article");
        if (response === null) {
            throw new Error("Expected the configuration response");
        }
        expect(response.querySelector("blockquote code")?.textContent).toContain('const entry_899 = "');
        expect(response.querySelectorAll("blockquote")).toHaveLength(1);
        expect(getByRole(response, "heading", { name: "Finished" })).toBeDefined();
        expect(response.textContent).not.toContain("```typescript");
        expect(response.textContent?.match(/x{60}/gu)).toHaveLength(900);
        expect(response.textContent).not.toContain("Latest output (text preview)");
    });
    await daemon.continueReply("hold after first delta", { outcome: "complete", output: [] });
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    expect(document.body.textContent).toContain("NEW_LIVE_OUTPUT");
});

test("Given a long table, nested list and reference link, When I load the entire answer, Then Markdown structures span the display limit without separate pages", {
    timeout: 30_000,
}, async () => {
    const rows = Array.from({ length: 1_200 }, (_, index) => `| service-${index} | ${"ready ".repeat(6)} |`).join("\n");
    const { app } = await startLongResponse(
        `\n\n## Services\n\n[Reference][guide]\n\n| Service | Status |\n| --- | --- |\n${rows}\n\n1. Parent\n   - Child\n\n[guide]: https://example.com/reference\n\nEND_OF_REPORT`,
    );
    await app.waitForView(() => expect(getByRole(document.body, "button", { name: "Load more text" })).toBeDefined());
    await loadEntireResponse(app);
    await app.waitForView(() => {
        const response = getByRole(document.body, "heading", { name: "Services" }).closest("article");
        if (response === null) {
            throw new Error("Expected the services response");
        }
        expect(response.querySelectorAll("table")).toHaveLength(1);
        expect(response.querySelectorAll("tbody tr")).toHaveLength(1_200);
        expect(response.querySelector("ol li ul li")?.textContent).toContain("Child");
        expect(getByRole(response, "link", { name: "Reference" }).getAttribute("href")).toBe(
            "https://example.com/reference",
        );
        expect(response.textContent).toContain("END_OF_REPORT");
    });
});
