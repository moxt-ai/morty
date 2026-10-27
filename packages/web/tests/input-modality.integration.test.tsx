import { getByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { createTestApp } from "./infra/test-app.tsx";

const inputModalityAttribute = "data-input-modality";

test("Given pointer input, When a menu item receives focus, Then keyboard-only focus styling remains off", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const switcher = await app.waitForView(() => getByRole(document.body, "button", { name: /Switch computer/ }));

    await app.user.click(switcher);
    const menu = await app.waitForView(() => getByRole(document.body, "menu"));

    expect(document.documentElement.getAttribute(inputModalityAttribute)).toBe("pointer");
    expect(menu).toHaveProperty("className", expect.stringContaining("shadow-[0_16px_42px_rgba(0,0,0,0.14)]"));
    expect(getComputedStyle(menu).outlineStyle).toBe("none");
});

test("Given keyboard input, When a menu item receives focus, Then keyboard focus styling is enabled", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const switcher = await app.waitForView(() => getByRole(document.body, "button", { name: /Switch computer/ }));

    switcher.focus();
    await app.user.keyboard("{ArrowDown}");
    await app.waitForView(() => getByRole(document.body, "menu"));

    expect(document.documentElement.getAttribute(inputModalityAttribute)).toBe("keyboard");
    const menu = getByRole(document.body, "menu");
    expect(getComputedStyle(menu).outlineStyle).toBe("none");
});
