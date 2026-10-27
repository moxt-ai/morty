import { getByRole, getByText } from "@testing-library/dom";
import { expect, test } from "vitest";
import { createTestApp } from "./infra/test-app.tsx";

test("Given the component library color page, When the user opens it, Then every color variable is listed with its Tailwind utility", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        page: { kind: "component-library", entryId: "color" },
    });
    await app.waitForView(() => getByRole(document.body, "heading", { name: "Color", level: 1 }));

    // Every group from styles.css is on the page, and each row names both the
    // Tailwind utility and the variable a reader has to edit.
    expect(getByRole(document.body, "heading", { name: "shadcn (Morty light)", level: 3 })).toBeTruthy();
    expect(getByRole(document.body, "heading", { name: "Morty interaction layer", level: 3 })).toBeTruthy();
    expect(getByRole(document.body, "heading", { name: "Morty semantic tokens", level: 3 })).toBeTruthy();
    expect(getByText(document.body, "bg-primary")).toBeTruthy();
    expect(getByText(document.body, /^--primary( · .+)?$/)).toBeTruthy();
    expect(getByText(document.body, /^--morty-fill-opacity-4( · .+)?$/)).toBeTruthy();
    await app.close();
});
