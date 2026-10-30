import { afterEach, expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { createTestApp } from "./infra/test-app.tsx";

const originalHeight = window.innerHeight;

function resizeViewport(height: number): void {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
    window.dispatchEvent(new Event("resize"));
}

afterEach(() => {
    resizeViewport(originalHeight);
});

async function openComposer() {
    const app = await createTestApp({ connectAgent: true });
    const composer = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    const form = composer.closest("form");
    if (form === null) {
        throw new Error("The composer is not inside a form");
    }
    return { app, composer, form };
}

test("Given a software keyboard shrinks the viewport, When I focus the composer, Then it marks the keyboard open until focus leaves", {
    timeout: 30_000,
}, async () => {
    const { app, composer, form } = await openComposer();

    await app.user.click(composer);
    expect(form.getAttribute("data-software-keyboard")).toBeNull();

    resizeViewport(originalHeight - 300);
    expect(form.getAttribute("data-software-keyboard")).toBe("open");

    composer.blur();
    expect(form.getAttribute("data-software-keyboard")).toBeNull();
});

test("Given another field already opened the keyboard, When I move focus to the composer, Then it marks the keyboard open", {
    timeout: 30_000,
}, async () => {
    const { app, composer, form } = await openComposer();

    resizeViewport(originalHeight - 300);
    expect(form.getAttribute("data-software-keyboard")).toBeNull();

    await app.user.click(composer);
    expect(form.getAttribute("data-software-keyboard")).toBe("open");
});

test("Given a focused composer on a viewport that never shrinks, When the page resizes slightly, Then the safe-area margin stays", {
    timeout: 30_000,
}, async () => {
    const { app, composer, form } = await openComposer();

    await app.user.click(composer);
    resizeViewport(originalHeight - 40);

    expect(form.getAttribute("data-software-keyboard")).toBeNull();
});
