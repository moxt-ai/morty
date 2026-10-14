import { getByLabelText, getByRole, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given the message composer, When the user clicks Add attachment and selects a file, Then the picker opens directly and the attachment appears", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(dataTestId.messageComposer);
    let pickerOpened = false;
    const observePicker = (event: Event) => {
        if (event.target instanceof HTMLInputElement && event.target.type === "file") {
            pickerOpened = true;
        }
    };
    document.addEventListener("click", observePicker);
    try {
        await app.user.click(getByRole(document.body, "button", { name: /^Add(?: attachment)?$/ }));
    } finally {
        document.removeEventListener("click", observePicker);
    }
    expect(pickerOpened).toBe(true);
    expect(queryByRole(document.body, "menu")).toBeNull();
    const input = getByLabelText(document.body, "Choose attachments");
    await app.user.upload(input, new File(["Attachment contents"], "notes.json", { type: "text/plain" }));
    await app.waitForView(() =>
        expect(getByRole(document.body, "list", { name: "Attachments" }).textContent).toContain("notes.json"),
    );
    await app.user.click(getByRole(document.body, "button", { name: "Remove notes.json" }));
    expect(queryByRole(document.body, "list", { name: "Attachments" })).toBeNull();
});
