import { getByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { createTestApp } from "./infra/test-app.tsx";

test("Given a remembered computer, When the user opens the component library, Then the address stays on the playground page", {
    timeout: 30_000,
}, async () => {
    const signedIn = await createTestApp();
    window.location.href = new URL("/playground/color", signedIn.origin).href;
    const app = await signedIn.reload();
    await app.waitForView(() => {
        expect(window.location.pathname).toBe("/playground/color");
        return getByRole(document.body, "heading", { name: "Color" });
    });
});
