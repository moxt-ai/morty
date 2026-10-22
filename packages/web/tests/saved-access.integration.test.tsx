import { getAllByRole, getByRole, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { createTestApp } from "./infra/test-app.tsx";

for (const path of ["/", "/chat"]) {
    test(`Given access validated from its original link, When I reopen ${path}, Then my saved chat opens and survives reload`, {
        timeout: 30_000,
    }, async () => {
        const app = await createTestApp({ page: { kind: "bootstrap", identity: true }, connectAgent: true });
        await app.queryElementByTestId(dataTestId.chatLanding);
        const originalScope = new URL(window.location.href).searchParams.get("identity");
        window.history.replaceState(null, "", path);
        const reopened = await app.reload();
        await reopened.queryElementByTestId(dataTestId.chatLanding);
        expect(new URL(window.location.href).searchParams.get("identity")).toBe(originalScope);
        expect(
            queryByRole(document.body, "heading", { name: "Continue your coding session from your phone." }),
        ).toBeNull();
        const reloaded = await reopened.reload();
        await reloaded.queryElementByTestId(dataTestId.chatLanding);
    });
}

test("Given saved access, When I open an invalid explicit identity link, Then Morty does not silently enter another identity", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap", identity: true }, connectAgent: true });
    await app.queryElementByTestId(dataTestId.chatLanding);
    window.history.replaceState(null, "", "/?identity=invalid");
    const reopened = await app.reload();
    await reopened.waitForView(() =>
        getByRole(document.body, "heading", { name: "Continue your coding session from your phone." }),
    );
    window.history.replaceState(null, "", "/");
    const home = await reopened.reload();
    await home.queryElementByTestId(dataTestId.chatLanding);
});

test("Given two saved identities, When I reopen Morty, Then I can explicitly continue with the selected access", {
    timeout: 30_000,
}, async () => {
    const first = await createTestApp({ page: { kind: "bootstrap", identity: true }, connectAgent: true });
    await first.queryElementByTestId(dataTestId.chatLanding);
    const firstScope = new URL(window.location.href).searchParams.get("identity");
    await first.close();
    const second = await createTestApp({
        connectAgent: true,
        agent: { id: "pi", label: "Pi" },
        page: { kind: "bootstrap", identity: true },
    });
    await second.queryElementByTestId(dataTestId.chatLanding);
    const secondScope = new URL(window.location.href).searchParams.get("identity");
    expect(secondScope).not.toBe(firstScope);
    window.history.replaceState(null, "", "/");
    const home = await second.reload();
    await home.waitForView(() => getByRole(document.body, "heading", { name: "Continue with saved access" }));
    const choices = getAllByRole(document.body, "link", { name: /Continue to/u });
    expect(choices).toHaveLength(2);
    expect(new URL(choices[0]?.getAttribute("href") ?? "", window.location.origin).searchParams.get("identity")).toBe(
        secondScope,
    );
    const setupLink = getByRole(document.body, "link", { name: "Set up another computer" });
    await home.user.click(setupLink);
    const setup = await home.reload();
    await setup.waitForView(() => getByRole(document.body, "textbox", { name: "Agent setup instruction" }));
    await setup.user.click(getByRole(document.body, "link", { name: "Continue with saved access" }));
    const returned = await setup.reload();
    await returned.waitForView(() => getByRole(document.body, "heading", { name: "Continue with saved access" }));
    const chosen = choices.find(
        (choice) =>
            new URL(choice.getAttribute("href") ?? "", window.location.origin).searchParams.get("identity") ===
            secondScope,
    );
    if (chosen === undefined) {
        throw new Error("Expected the second saved identity to be offered.");
    }
    const currentChoice = getAllByRole(document.body, "link", { name: /Continue to/u }).find(
        (choice) => choice.getAttribute("href") === chosen.getAttribute("href"),
    );
    if (currentChoice === undefined) {
        throw new Error("Expected access to remain available after setup.");
    }
    await returned.user.click(currentChoice);
    const continued = await returned.reload();
    await continued.queryElementByTestId(dataTestId.chatLanding);
    expect(new URL(window.location.href).searchParams.get("identity")).toBe(secondScope);
});

test("Given saved access revoked on the server, When I reopen Morty, Then setup appears and revoked access does not return", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap", identity: true }, connectAgent: true });
    await app.queryElementByTestId(dataTestId.chatLanding);
    const signal = new AbortController().signal;
    const response = await app.transport.fetch(
        new Request(`${app.origin}/morty/api/projects/${app.identity.projectId}/identity/remote-access`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${await app.identity.getToken(signal)}` },
            signal,
        }),
    );
    expect(response.status).toBe(204);
    window.history.replaceState(null, "", "/");
    const home = await app.reload();
    await home.waitForView(() =>
        getByRole(document.body, "heading", { name: "Continue your coding session from your phone." }),
    );
    const reloaded = await home.reload();
    await reloaded.waitForView(() =>
        getByRole(document.body, "heading", { name: "Continue your coding session from your phone." }),
    );
});

test("Given two saved identities and one deleted Bot, When I reopen Morty, Then the remaining access opens and survives another visit", {
    timeout: 30_000,
}, async () => {
    const first = await createTestApp({ page: { kind: "bootstrap", identity: true }, connectAgent: true });
    await first.queryElementByTestId(dataTestId.chatLanding);
    await first.close();
    const second = await createTestApp({
        connectAgent: true,
        agent: { id: "pi", label: "Pi" },
        page: { kind: "bootstrap", identity: true },
    });
    await second.queryElementByTestId(dataTestId.chatLanding);
    const secondScope = new URL(window.location.href).searchParams.get("identity");
    const signal = new AbortController().signal;
    const replacement = await second.transport.fetch(
        new Request(`${second.origin}/morty/api/projects/${first.identity.projectId}/management/bots`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${await first.identity.getToken(signal)}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({ displayName: "Replacement Machine" }),
            signal,
        }),
    );
    expect(replacement.status).toBe(201);
    const deleted = await second.transport.fetch(
        new Request(`${second.origin}/morty/api/projects/${first.identity.projectId}/management/bots/${first.botId}`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${await first.identity.getToken(signal)}` },
            signal,
        }),
    );
    expect(deleted.status).toBe(204);
    window.history.replaceState(null, "", "/");
    const home = await second.reload();
    await home.queryElementByTestId(dataTestId.chatLanding);
    expect(new URL(window.location.href).searchParams.get("identity")).toBe(secondScope);
    window.history.replaceState(null, "", "/chat");
    const nextVisit = await home.reload();
    await nextVisit.queryElementByTestId(dataTestId.chatLanding);
});

test("Given a connected saved chat, When I choose to set up another computer, Then I can read the instruction and return to the same access", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap", identity: true }, connectAgent: true });
    await app.queryElementByTestId(dataTestId.chatLanding);
    const scope = new URL(window.location.href).searchParams.get("identity");
    await app.user.click(getByRole(document.body, "button", { name: "User menu" }));
    await app.user.click(getByRole(document.body, "menuitem", { name: "Set up another computer" }));
    const setup = await app.reload();
    await setup.waitForView(() => getByRole(document.body, "textbox", { name: "Agent setup instruction" }));
    await setup.user.click(getByRole(document.body, "link", { name: "Continue with saved access" }));
    const returned = await setup.reload();
    await returned.queryElementByTestId(dataTestId.chatLanding);
    expect(new URL(window.location.href).searchParams.get("identity")).toBe(scope);
});
