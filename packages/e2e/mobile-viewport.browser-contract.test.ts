import { expect, test } from "./infra/test.ts";

test.use({
    contextOptions: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
});

// iOS Safari magnifies a focused text field by 16 / fontSize when the page lets
// the user scale above one, so focusing the 14px prompt zoomed the whole chat.
// The document must cap the declared scale instead of enlarging the prompt text.
test("Given a phone, When the user opens Morty, Then the document keeps the device width and stops the browser from magnifying the prompt", async ({
    runtime,
}) => {
    const { page } = runtime;
    await runtime.openChat();
    const viewportDeclaration = await page.locator('meta[name="viewport"]').getAttribute("content");
    expect(viewportDeclaration).toContain("width=device-width");
    expect(viewportDeclaration).toContain("initial-scale=1");
    expect(viewportDeclaration).toContain("maximum-scale=1");
});
