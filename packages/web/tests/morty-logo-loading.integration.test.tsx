import { fireEvent, getByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given the Morty logo is still loading, When it finishes loading, Then the placeholder is replaced by the mark without moving the navigation", async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId("chat-message-composer");
    const navigation = getByRole(document.body, "complementary", { name: "Morty navigation" });
    const logo = navigation.querySelector(`[data-testid="${dataTestId.mortyLogo}"]`);
    expect(logo?.getAttribute("data-state")).toBe("loading");
    expect(logo?.querySelector('[aria-hidden="true"]')).not.toBeNull();
    const mark = logo?.querySelector("img");
    expect(mark).toBeInstanceOf(HTMLImageElement);
    if (!(mark instanceof HTMLImageElement)) {
        throw new Error("Expected the Morty mark image");
    }
    expect(mark.className).toContain("opacity-0");

    fireEvent.load(mark);

    expect(logo?.getAttribute("data-state")).toBe("loaded");
    expect(logo?.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(mark.className).toContain("opacity-100");
});
