import { getByLabelText, getByRole } from "@testing-library/dom";
import { expect, onTestFinished, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

const REMOVE_ATTACHMENT = 'button[aria-label="Remove notes.json"]';

test("Given a first prompt with an attachment, When it creates the conversation, Then the message being sent cannot be edited and arrives whole", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const composer = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    await app.user.upload(
        getByLabelText(document.body, "Choose attachments"),
        new File(["Attachment contents"], "notes.json", { type: "text/plain" }),
    );
    await app.waitForView(() =>
        expect(getByRole(document.body, "list", { name: "Attachments" }).textContent).toContain("notes.json"),
    );

    // From the send on, the queued message is shown as sent. Nothing may offer to remove its attachment, since a
    // removal could not change what is sent.
    let removableWhileSending = false;
    let sending = false;
    const observer = new MutationObserver(() => {
        if (!sending) {
            return;
        }
        for (const button of document.querySelectorAll(REMOVE_ATTACHMENT)) {
            if (button instanceof HTMLButtonElement && !button.disabled) {
                removableWhileSending = true;
            }
        }
    });
    observer.observe(document.body, { attributes: true, childList: true, subtree: true });
    const startSending = (event: Event): void => {
        if (event.target instanceof Element && event.target.closest(`[data-testid="${dataTestId.sendMessage}"]`)) {
            sending = true;
        }
    };
    document.addEventListener("click", startSending, { capture: true });
    onTestFinished(() => {
        observer.disconnect();
        document.removeEventListener("click", startSending, { capture: true });
    });
    await sendPrompt(app, composer, "Read the attached notes");
    expect(sending).toBe(true);

    await app.waitForView(() => {
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Read the attached notes")),
        ).toBe(true);
        // The conversation history renders the delivered attachment by its contents.
        expect(getByRole(document.body, "region", { name: "Conversation" }).textContent).toContain(
            "Attachment contents",
        );
    });
    observer.disconnect();
    expect(removableWhileSending).toBe(false);
    expect(document.querySelector(REMOVE_ATTACHMENT)).toBeNull();
});

test("Given an attachment upload is rejected before turn submission, When I send my first message, Then my unsent text and attachment remain editable", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const composer = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    const name = `${"notes".repeat(101)}.json`;
    await app.user.upload(
        getByLabelText(document.body, "Choose attachments"),
        new File(["Attachment contents"], name, { type: "text/plain" }),
    );
    await app.waitForView(() =>
        expect(getByRole(document.body, "list", { name: "Attachments" }).textContent).toContain(name),
    );
    await sendPrompt(app, composer, "Keep this unsent message");
    await app.waitForView(() => {
        expect(getByRole(document.body, "alert").textContent).not.toBe("");
        const draft = app.elementByTestId(dataTestId.messageComposer);
        expect(draft).toBeInstanceOf(HTMLTextAreaElement);
        if (!(draft instanceof HTMLTextAreaElement)) {
            throw new Error("Expected an editable composer");
        }
        expect(draft.disabled).toBe(false);
        expect(draft.value).toBe("Keep this unsent message");
        expect(getByRole(document.body, "button", { name: `Remove ${name}` }).hasAttribute("disabled")).toBe(false);
    });
});
