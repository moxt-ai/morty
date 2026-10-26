import { getByRole, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { interactiveHtml } from "../../../tests/support/fake-daemon/html-preview.ts";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given a local file link in an active response, When more output arrives during a click, Then the link still opens its preview", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected Runtime");
    }
    await daemon.writeFiles(new Map([["/workspace/index.html", { content: interactiveHtml, mediaType: "text/html" }]]));
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "hold after first delta");
    await app.waitForView(() => expect(document.body.textContent).toContain("Partial reply"));
    await daemon.continueReply("hold after first delta", {
        outcome: "hold",
        output: [{ kind: "text", text: "\n\n[Open result](index.html)\n\n" }],
    });
    const link = await app.waitForView(() => getByRole(document.body, "button", { name: "Open result" }));
    await app.user.pointer({ keys: "[MouseLeft>]", target: link });
    await daemon.continueReply("hold after first delta", {
        outcome: "hold",
        output: [{ kind: "text", text: "More output arrived." }],
    });
    await app.waitForView(() => expect(document.body.textContent).toContain("More output arrived."));
    await app.user.pointer({
        keys: "[/MouseLeft]",
        target: getByRole(document.body, "button", { name: "Open result" }),
    });
    const preview = await app.queryElementByTestId(dataTestId.filePreview);
    await app.user.click(await app.waitForView(() => getByRole(preview, "button", { name: "View source" })));
    await app.waitForView(() =>
        expect(getByRole(preview, "region", { name: "File contents" }).textContent).toContain("Delivery review"),
    );
    await daemon.continueReply("hold after first delta", { outcome: "complete", output: [] });
});

test("Given the agent links a file relative to the working directory, When the user opens the reference, Then Chat previews the local file instead of blocking the link", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, "show cwd relative link");
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    await app.queryElementByTestId(dataTestId.localFileLink);
    await app.waitForView(() => expect(document.body.textContent).not.toContain("[blocked]"));
    await app.user.click(await app.waitForView(() => getByRole(document.body, "button", { name: "index.html" })));
    const preview = await app.queryElementByTestId(dataTestId.filePreview);
    await app.waitForView(() => getByRole(preview, "button", { name: "View source" }));
    await app.user.click(getByRole(preview, "button", { name: "View source" }));
    await app.waitForView(() =>
        expect(getByRole(preview, "region", { name: "File contents" }).textContent).toContain(
            "Working directory index",
        ),
    );
});

test("Given an HTML link points to an unavailable file, When the file becomes available and the user retries, Then the preview recovers in the same conversation", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement) || app.daemon === null) {
        throw new Error("Expected a composer and connected Runtime");
    }
    await sendPrompt(app, composer, "show missing result");
    await app.queryElementByTestId(dataTestId.localFileLink);
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    await app.user.click(
        await app.waitForView(() => getByRole(document.body, "button", { name: "Open missing result" })),
    );
    const preview = await app.queryElementByTestId(dataTestId.filePreview);
    await app.waitForView(() => expect(getByRole(preview, "alert").textContent).toContain("could not be opened"));
    await app.daemon.writeFiles(
        new Map([["/workspace/missing-result.html", { content: interactiveHtml, mediaType: "text/html" }]]),
    );
    await app.user.click(getByRole(preview, "button", { name: "Reload file" }));
    await app.waitForView(() => getByRole(preview, "button", { name: "View source" }));
    await app.user.click(getByRole(preview, "button", { name: "View source" }));
    await app.waitForView(() =>
        expect(getByRole(preview, "region", { name: "File contents" }).textContent).toContain("Delivery review"),
    );
    expect(queryByRole(preview, "alert")).toBeNull();
    await app.user.click(getByRole(preview, "button", { name: "Close file preview" }));
    expect(app.optionalElementByTestId(dataTestId.filePreview)).toBeNull();
    expect(getByRole(document.body, "button", { name: "Open missing result" })).toBeDefined();
});
