import { getByRole, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { interactiveHtml } from "../../../tests/support/fake-daemon/html-preview.ts";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

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

test("Given a Runtime goes offline after an HTML result was opened, When the user reloads, Then the failed read has a retry action and can be closed", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement) || app.daemon === null) {
        throw new Error("Expected a composer and connected Runtime");
    }
    await sendPrompt(app, composer, "show interactive result");
    await app.queryElementByTestId(dataTestId.localFileLink);
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    await app.user.click(
        await app.waitForView(() => getByRole(document.body, "button", { name: "Open delivery review" })),
    );
    const preview = await app.queryElementByTestId(dataTestId.filePreview);
    await app.waitForView(() => getByRole(preview, "button", { name: "View source" }));
    await app.daemon.disconnect();
    await app.user.click(getByRole(preview, "button", { name: "Reload file" }));
    await app.waitForView(() => expect(getByRole(preview, "alert").textContent).toContain("offline or disconnected"));
    expect(getByRole(preview, "button", { name: "Reload file" })).toBeDefined();
    await app.user.click(getByRole(preview, "button", { name: "Close file preview" }));
    expect(app.optionalElementByTestId(dataTestId.filePreview)).toBeNull();
});
