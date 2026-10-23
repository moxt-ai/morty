import { getByRole, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { interactiveHtml } from "../../../tests/support/fake-daemon/html-preview.ts";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

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
