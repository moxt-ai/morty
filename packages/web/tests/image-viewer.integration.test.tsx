import { getAllByRole, getByLabelText, getByRole, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { expandProcessSections, sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

const png = Uint8Array.from(
    atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV4kAAAAASUVORK5CYII="),
    (character) => character.charCodeAt(0),
);

test("Given two draft images, When the user opens, navigates and closes the viewer, Then the draft, attachments and keyboard focus remain intact", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    await app.user.type(composer, "Please compare these screenshots");
    await app.user.upload(getByLabelText(document.body, "Choose attachments"), [
        new File([png], "before.png", { type: "image/png" }),
        new File([png], "after.png", { type: "image/png" }),
    ]);
    const trigger = await app.waitForView(() => getByRole(document.body, "button", { name: "View image: before.png" }));
    await app.user.click(trigger);
    const viewer = getByRole(document.body, "dialog", { name: "Image viewer" });
    expect(getByRole(viewer, "img", { name: "before.png" }).getAttribute("src")).toMatch(/^blob:/u);
    expect(viewer.textContent).toContain("1 of 2");
    await app.user.click(getByRole(viewer, "button", { name: "Next image" }));
    expect(getByRole(viewer, "img", { name: "after.png" })).toBeDefined();
    expect(viewer.textContent).toContain("2 of 2");
    await app.user.keyboard("{ArrowLeft}");
    expect(getByRole(viewer, "img", { name: "before.png" })).toBeDefined();
    await app.user.keyboard("{Escape}");
    await app.waitForView(() => expect(queryByRole(document.body, "dialog", { name: "Image viewer" })).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(getByRole(document.body, "textbox", { name: "Message" }).getAttribute("disabled")).toBeNull();
    expect(composer).toHaveProperty("value", "Please compare these screenshots");
    expect(getAllByRole(getByRole(document.body, "list", { name: "Attachments" }), "img")).toHaveLength(2);
    await app.user.click(getByRole(document.body, "button", { name: "Remove after.png" }));
    expect(queryByRole(document.body, "dialog", { name: "Image viewer" })).toBeNull();
    expect(getAllByRole(getByRole(document.body, "list", { name: "Attachments" }), "img")).toHaveLength(1);
});

test("Given sent image attachments, When the user opens an image, Then the viewer contains only that message's images", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    await app.user.upload(getByLabelText(document.body, "Choose attachments"), [
        new File([png], "first.png", { type: "image/png" }),
        new File([png], "second.png", { type: "image/png" }),
    ]);
    await app.waitForView(() => getByRole(document.body, "button", { name: "View image: second.png" }));
    await sendPrompt(app, composer, "Compare attachments");
    await app.waitForView(() => expect(queryByRole(document.body, "list", { name: "Attachments" })).toBeNull());
    const image = await app.waitForView(() => {
        const images = app.elementsByTestId(dataTestId.userMessageImage);
        expect(images).toHaveLength(2);
        const first = images[0];
        if (first === undefined) {
            throw new Error("Expected the first sent image");
        }
        return first;
    });
    await app.user.click(image);
    const viewer = getByRole(document.body, "dialog", { name: "Image viewer" });
    expect(viewer.textContent).toContain("1 of 2");
    await app.user.click(getByRole(viewer, "button", { name: "Close image viewer" }));
    await app.waitForView(() => expect(queryByRole(document.body, "dialog", { name: "Image viewer" })).toBeNull());
});

test("Given a streaming reply with images, When the user opens its gallery and output continues, Then the open gallery remains stable and other messages stay separate", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    await sendPrompt(app, composer, "show image gallery");
    const trigger = await app.waitForView(() =>
        getByRole(document.body, "button", { name: "View image: First picture" }),
    );
    await app.waitForView(() => getByRole(document.body, "button", { name: "View image: Second picture" }));
    await app.user.click(trigger);
    const viewer = getByRole(document.body, "dialog", { name: "Image viewer" });
    expect(viewer.textContent).toContain("1 of 2");
    if (app.daemon === null) {
        throw new Error("Expected a connected Runtime");
    }
    await app.daemon.continueReply("show image gallery", {
        outcome: "complete",
        output: [{ kind: "text", text: "\n\n![Third picture](generated-picture.png)" }],
    });
    await app.waitForView(() => getByRole(document.body, "button", { name: "View image: Third picture" }));
    expect(viewer.textContent).toContain("1 of 2");
    await app.user.click(getByRole(viewer, "button", { name: "Next image" }));
    expect(getByRole(viewer, "img", { name: "Second picture" })).toBeDefined();
    await app.user.click(getByRole(viewer, "button", { name: "Close image viewer" }));
    await app.waitForView(() => expect(queryByRole(document.body, "dialog", { name: "Image viewer" })).toBeNull());
    const currentTrigger = getByRole(document.body, "button", { name: "View image: First picture" });
    expect(document.activeElement).toBe(currentTrigger);
    await app.user.click(currentTrigger);
    expect(getByRole(document.body, "dialog", { name: "Image viewer" }).textContent).toContain("1 of 3");
});

test("Given an unavailable local image, When the file becomes available and the user retries, Then it can be opened without resending the message", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    await sendPrompt(app, composer, "show missing image");
    const retry = await app.waitForView(() => getByRole(document.body, "button", { name: "Retry image" }));
    if (app.daemon === null) {
        throw new Error("Expected a connected Runtime");
    }
    await app.daemon.writeFiles(new Map([["/workspace/recovered.png", { content: png, mediaType: "image/png" }]]));
    await app.user.click(retry);
    const trigger = await app.waitForView(() =>
        getByRole(document.body, "button", { name: "View image: Recovered picture" }),
    );
    await app.user.click(trigger);
    expect(
        getByRole(getByRole(document.body, "dialog", { name: "Image viewer" }), "img", { name: "Recovered picture" }),
    ).toBeDefined();
});

for (const [prompt, label] of [
    ["generate an image", "Generate image"],
    ["view an image", "View image"],
]) {
    test(`Given a ${label} tool result, When the user opens its image, Then the shared viewer shows that result`, {
        timeout: 30_000,
    }, async () => {
        const app = await createTestApp({ connectAgent: true });
        const composer = await app.queryElementByTestId(dataTestId.messageComposer);
        await sendPrompt(app, composer, prompt ?? "");
        await expandProcessSections(app);
        const disclosure = await app.waitForView(() =>
            getByRole(document.body, "button", { name: `${label} Tool succeeded` }),
        );
        await app.user.click(disclosure);
        const trigger = await app.waitForView(() => getByRole(document.body, "button", { name: "View image: Image" }));
        await app.user.click(trigger);
        expect(getByRole(document.body, "dialog", { name: "Image viewer" }).textContent).toContain("1 of 1");
    });
}

test("Given an image in a streaming reply, When the reply completes between pointer down and release, Then the same image still opens", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (app.daemon === null) {
        throw new Error("Expected a connected Runtime");
    }
    await sendPrompt(app, composer, "show image gallery");
    const trigger = await app.waitForView(() =>
        getByRole(document.body, "button", { name: "View image: First picture" }),
    );
    await app.user.pointer({ keys: "[MouseLeft>]", target: trigger });
    await app.daemon.continueReply("show image gallery", { outcome: "complete", output: [] });
    await app.waitForView(() => expect(queryByRole(document.body, "button", { name: "Stop agent output" })).toBeNull());
    await app.user.pointer({
        keys: "[/MouseLeft]",
        target: getByRole(document.body, "button", { name: "View image: First picture" }),
    });
    expect(getByRole(document.body, "dialog", { name: "Image viewer" })).toBeDefined();
});

test("Given a tool image is open while the agent works, When the user collapses its process segment, Then the viewer keeps showing the image", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    if (app.daemon === null) {
        throw new Error("Expected a connected Runtime");
    }
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "hold image tool");
    await expandProcessSections(app);
    await app.user.click(
        await app.waitForView(() => getByRole(document.body, "button", { name: "Generate image Tool succeeded" })),
    );
    await app.user.click(
        await app.waitForView(() => getByRole(document.body, "button", { name: "View image: Image" })),
    );
    const viewer = getByRole(document.body, "dialog", { name: "Image viewer" });
    await app.daemon.continueReply("hold image tool", {
        outcome: "complete",
        output: [{ kind: "text", text: "The generated image is ready." }],
    });
    await app.waitForView(() => expect(document.body.textContent).toContain("The generated image is ready."));
    await app.user.click(getByRole(document.body, "button", { name: "1 step", expanded: true }));
    expect(getByRole(document.body, "dialog", { name: "Image viewer" })).toBe(viewer);
    expect(getByRole(viewer, "img", { name: "Image" })).toBeDefined();
    await app.user.click(getByRole(viewer, "button", { name: "Close image viewer" }));
    await app.waitForView(() => expect(queryByRole(document.body, "dialog", { name: "Image viewer" })).toBeNull());
    expect(document.activeElement).toBe(getByRole(document.body, "button", { name: "1 step" }));
});
