import { fireEvent, getByLabelText, getByRole, queryByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
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

test("Given a draft attachment, When Chat remounts, Then the attachment remains until the user starts a new conversation", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(dataTestId.messageComposer);
    await app.user.upload(
        getByLabelText(document.body, "Choose attachments"),
        new File(["Keep this draft"], "draft.json", { type: "text/plain" }),
    );
    await app.waitForView(() =>
        expect(getByRole(document.body, "list", { name: "Attachments" }).textContent).toContain("draft.json"),
    );
    app.remount();
    await app.queryElementByTestId(dataTestId.messageComposer);
    expect(getByRole(document.body, "list", { name: "Attachments" }).textContent).toContain("draft.json");
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    expect(queryByRole(document.body, "list", { name: "Attachments" })).toBeNull();
});

test("Given an attachment is being read, When the user removes an earlier attachment, Then completing the read preserves that removal", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(dataTestId.messageComposer);
    const input = getByLabelText(document.body, "Choose attachments");
    await app.user.upload(input, new File(["Remove this"], "removed.json", { type: "text/plain" }));
    await app.waitForView(() =>
        expect(getByRole(document.body, "list", { name: "Attachments" }).textContent).toContain("removed.json"),
    );
    // Both user events happen before asynchronous file I/O can complete.
    act(() => {
        fireEvent.change(input, { target: { files: [new File(["Keep this"], "added.json", { type: "text/plain" })] } });
        fireEvent.click(getByRole(document.body, "button", { name: "Remove removed.json" }));
    });
    await app.waitForView(() => {
        const attachments = getByRole(document.body, "list", { name: "Attachments" });
        expect(attachments.textContent).toContain("added.json");
        expect(attachments.textContent).not.toContain("removed.json");
    });
});
