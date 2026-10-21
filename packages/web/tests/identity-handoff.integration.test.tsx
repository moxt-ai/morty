import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getByRole, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { encodeIdentityScope } from "../src/services/identity/identity-scope-url.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given a stored identity for the active project, When the user shares access, Then a working transfer link and QR code appear", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true, page: { kind: "bootstrap", identity: true } });
    await app.user.click(await app.queryElementByTestId(dataTestId.shareIdentity));
    const sharing = await app.queryElementByTestId(dataTestId.identitySharing);
    const image = getByRole(sharing, "img", { name: "Continue on another device QR code" });
    expect(image.getAttribute("src")).toMatch(/^data:image\/png;base64,/u);
    const link = getByRole(sharing, "link", { name: "Open sharing link" });
    const url = new URL(link.getAttribute("href") ?? "");
    expect(url.origin).toBe(app.origin);
    expect(url.pathname).toBe("/continue");
    expect(url.hash).toMatch(/^#code=\S+$/u);
    expect(queryByRole(sharing, "alert")).toBeNull();
});

test("Given a native session handoff, When the page loads, Then it tells the user the session is opening instead of offering choices and a QR code", {
    timeout: 30_000,
}, async () => {
    const sessionId = "01a0d270-0d62-7003-98df-22a5d11dc644";
    const app = await createTestApp({
        agent: { id: "pi", label: "Pi" },
        connectAgent: true,
        nativeSessionIds: new Set([sessionId]),
        page: { harness: "pi", kind: "continue", sessionId },
    });

    expect(await app.waitForView(() => getByRole(document.body, "status", { name: "Opening session" }))).toBeInstanceOf(
        HTMLElement,
    );
    expect(document.body.textContent).toContain("Opening the original session in Morty.");
    expect(queryByRole(document.body, "button", { name: "Open session" })).toBeNull();
    expect(queryByRole(document.body, "button", { name: "Fork session" })).toBeNull();
    expect(queryByRole(document.body, "button", { name: "Go to Morty" })).toBeNull();
    expect(queryByRole(document.body, "img", { name: "QR code to continue on another device" })).toBeNull();
    expect(queryByRole(document.body, "button", { name: "Show QR code" })).toBeNull();
});

test("Given a native session handoff, When the page loads, Then it shows no site header and no entry back to Morty home", {
    timeout: 30_000,
}, async () => {
    const sessionId = "01a0d270-0d62-7003-98df-22a5d11dc644";
    const app = await createTestApp({
        agent: { id: "pi", label: "Pi" },
        connectAgent: true,
        nativeSessionIds: new Set([sessionId]),
        page: { harness: "pi", kind: "continue", sessionId },
    });

    await app.waitForView(() => getByRole(document.body, "heading", { name: "Continue native session" }));
    expect(document.body.textContent).not.toContain("Your agents. Connected.");
    expect(document.body.querySelector("header")).toBeNull();
    expect(queryByRole(document.body, "link")).toBeNull();
});

test("Given a new browser, When Morty loads, Then Morty opens without presenting a workspace concept", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap" } });

    expect(
        await app.waitForView(() =>
            getByRole(document.body, "heading", { name: "Continue your coding session from your phone." }),
        ),
    ).toBeInstanceOf(HTMLElement);
    expect(document.body.textContent).not.toContain("Local agents");
    expect(document.body.textContent?.toLowerCase()).not.toContain("workspace");
});

test("Given Morty access from a finished setup, When the user reopens Morty in a fresh browser session, Then the chat opens directly with the identity kept in the address", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap", identity: true }, connectAgent: true });

    expect(await app.queryElementByTestId(dataTestId.chatLanding)).toBeInstanceOf(HTMLElement);
    expect(queryByRole(document.body, "heading", { name: "Continue your coding session from your phone." })).toBeNull();
    expect(window.location.search).toContain("identity=");
    expect(window.sessionStorage.getItem("mobius.anonymous-credential.v2")).toBeNull();
});

test("Given shared Morty access, When the user continues on another device, Then the visible entry opens sharing with its scope and expiry before the link", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap", identity: true } });
    await app.user.click(await app.queryElementByTestId(dataTestId.closeDialog));
    const share = await app.waitForView(() =>
        getByRole(document.body, "button", { name: "Continue on another device" }),
    );
    expect(share.textContent).toContain("Continue on another device");
    await app.user.click(share);

    const dialog = getByRole(document.body, "dialog", { name: "Continue on another device" });
    expect(dialog.textContent).toContain(
        "Anyone with this link can use your current Morty identity to view and control sessions in this project",
    );
    expect(dialog.textContent).toContain("not just the current conversation");
    expect(dialog.textContent).toContain("24 hours");
    expect(dialog.textContent).toContain("Access already granted does not end when the link expires");
    const link = await app.waitForView(() => getByRole(dialog, "link", { name: "Open sharing link" }));
    expect(getByRole(dialog, "img", { name: "Continue on another device QR code" })).toBeInstanceOf(HTMLImageElement);
    const description = getByRole(dialog, "heading", { name: "Continue on another device" }).parentElement;
    if (description === null) {
        throw new Error("The sharing description must precede its link.");
    }
    expect(description.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(queryByRole(dialog, "button", { name: "Confirm" })).toBeNull();
});

test("Given a native session handoff without a matching Agent, When the page loads, Then opening fails with the reason", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        page: {
            harness: "pi",
            kind: "continue",
            sessionId: "01a0d270-0d62-7003-98df-22a5d11dc644",
        },
    });

    const alert = await app.waitForView(() => getByRole(document.body, "alert"));
    expect(alert.textContent).toContain("handoff harness is unavailable");
    expect(getByRole(document.body, "heading", { name: "Continue native session" })).toBeInstanceOf(HTMLElement);
    expect(queryByRole(document.body, "button", { name: "Fork session" })).toBeNull();
});

test("Given opening a native session fails, When the user tries again, Then the page re-runs the same open-session request", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        page: {
            harness: "pi",
            kind: "continue",
            sessionId: "01a0d270-0d62-7003-98df-22a5d11dc644",
        },
    });
    await app.waitForView(() => {
        expect(getByRole(document.body, "alert").textContent).toContain("handoff harness is unavailable");
    });

    // The retry must reach the open-session step again: once a Runtime answers
    // for the redeemed access, the failure moves from the missing Agent to the
    // missing native session.
    await app.connectAgent({ id: "pi", label: "Pi" });
    await app.user.click(getByRole(document.body, "button", { name: "Try again" }));

    await app.waitForView(() => {
        expect(getByRole(document.body, "alert").textContent).toContain("The native session was not found");
    });
    expect(getByRole(document.body, "button", { name: "Try again" })).toBeInstanceOf(HTMLButtonElement);
});

test("Given the Morty access was redeemed and opening the original session failed, When the user views the failure page, Then they see the reason, retry, and an entry into Morty", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        agent: { id: "pi", label: "Pi" },
        connectAgent: true,
        page: {
            harness: "pi",
            kind: "continue",
            sessionId: "01a0d270-0d62-7003-98df-22a5d11dc644",
        },
    });

    const alert = await app.waitForView(() => getByRole(document.body, "alert"));
    expect(alert.textContent).toContain("The native session was not found");
    expect(getByRole(document.body, "heading", { name: "Continue native session" })).toBeInstanceOf(HTMLElement);
    expect(getByRole(document.body, "button", { name: "Try again" })).toBeInstanceOf(HTMLButtonElement);
    expect(getByRole(document.body, "button", { name: "Go to Morty" })).toBeInstanceOf(HTMLButtonElement);

    await app.user.click(getByRole(document.body, "button", { name: "Try again" }));

    await app.waitForView(() => {
        expect(getByRole(document.body, "alert").textContent).toContain("The native session was not found");
    });
    expect(getByRole(document.body, "button", { name: "Go to Morty" })).toBeInstanceOf(HTMLButtonElement);
});

test("Given the Morty access was not redeemed, When the failure page shows, Then entering Morty home is not offered", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        page: {
            code: (application) => `mobius_transfer_v2.${application.identity.projectId}.${"a".repeat(43)}`,
            harness: "pi",
            kind: "continue",
            sessionId: "01a0d270-0d62-7003-98df-22a5d11dc644",
        },
    });

    const alert = await app.waitForView(() => getByRole(document.body, "alert"));
    expect(alert.textContent).toContain("This transfer link has expired or been revoked.");
    expect(queryByRole(document.body, "button", { name: "Go to Morty" })).toBeNull();
    expect(getByRole(document.body, "button", { name: "Try again" })).toBeInstanceOf(HTMLButtonElement);
});

test("Given a native session handoff whose Runtime went offline, When the page loads, Then the page reports Mobius is disconnected instead of a transfer-link problem", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        prepare: async (application) => {
            const runtime = await application.connectAgent({ id: "claude", label: "Claude" });
            await runtime.disconnect();
        },
        page: {
            harness: "claude",
            kind: "continue",
            sessionId: "01a0d270-0d62-7003-98df-22a5d11dc644",
        },
    });

    const alert = await app.waitForView(() => getByRole(document.body, "alert"));
    expect(alert.textContent).toContain("Your Mobius is disconnected");
    expect(alert.textContent).toContain("Start your Mobius");
    expect(alert.textContent?.toLowerCase()).not.toContain("transfer link");
    expect(getByRole(document.body, "button", { name: "Try again" })).toBeInstanceOf(HTMLButtonElement);
});

test("Given shared Morty access, When the user opens the user menu, Then replacing the current user is unavailable", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp();
    await app.user.click(await app.queryElementByTestId(dataTestId.closeDialog));
    await app.user.click(await app.queryElementByTestId(dataTestId.userMenu));

    expect(queryByRole(document.body, "menuitem", { name: "Replace current user" })).toBeNull();
});

test("Given connected shared Morty access, When the user refreshes Network latency, Then every network hop latency updates", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    await app.user.click(await app.queryElementByTestId(dataTestId.userMenu));
    await app.user.click(getByRole(document.body, "menuitem", { name: "Network latency" }));

    const dialog = getByRole(document.body, "dialog", { name: "Network latency" });
    await app.waitForView(() => {
        expect(dialog.textContent).toContain("Mobius location: Western North America");
        expect(dialog.textContent).toContain("Browser ↔ Morty");
        expect(dialog.textContent).toContain("Browser ↔ Mobius");
        expect(dialog.textContent).toContain("Morty ↔ Mobius");
        expect(dialog.textContent).toContain("Mobius ↔ Daemon");
        expect(getByRole(dialog, "status", { name: "Browser to Morty latency" }).textContent).toMatch(/^\d+ ms$/u);
        expect(getByRole(dialog, "status", { name: "Browser to Mobius latency" }).textContent).toMatch(/^\d+ ms$/u);
        expect(getByRole(dialog, "status", { name: "Morty to Mobius latency" }).textContent).toMatch(/^\d+ ms$/u);
        expect(getByRole(dialog, "status", { name: "Mobius to daemon latency" }).textContent).toMatch(/^\d+ ms$/u);
    });

    await app.user.click(getByRole(dialog, "button", { name: "Refresh network latency" }));

    expect(getByRole(dialog, "status", { name: "Measuring network latency" })).toBeInstanceOf(HTMLElement);
    await app.waitForView(() => {
        expect(getByRole(dialog, "status", { name: "Browser to Morty latency" }).textContent).toMatch(/^\d+ ms$/u);
        expect(getByRole(dialog, "status", { name: "Browser to Mobius latency" }).textContent).toMatch(/^\d+ ms$/u);
        expect(getByRole(dialog, "status", { name: "Morty to Mobius latency" }).textContent).toMatch(/^\d+ ms$/u);
        expect(getByRole(dialog, "status", { name: "Mobius to daemon latency" }).textContent).toMatch(/^\d+ ms$/u);
    });
});

test("Given current Morty access, When the user opens its visible end action, Then the confirmation explains conditional scope without promising immediate disconnection", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap", identity: true } });
    await app.user.click(await app.queryElementByTestId(dataTestId.closeDialog));
    const endAccess = getByRole(document.body, "button", { name: "End current access" });
    expect(endAccess.textContent).toContain("End current access");
    await app.user.click(endAccess);

    const dialog = await app.queryElementByTestId(dataTestId.endRemoteAccessDialog);
    await app.waitForView(() =>
        expect(getByRole(dialog, "button", { name: "End current access" }).hasAttribute("disabled")).toBe(false),
    );
    expect(dialog.textContent).toContain("If you joined through a link");
    expect(dialog.textContent).toContain("Other sharing links and recovery access stay active");
    expect(dialog.textContent).toContain("Already-open sessions elsewhere may keep working until their access expires");
    expect(dialog.textContent).toContain("Your local agent and tasks keep running");
    expect(queryByRole(dialog, "textbox", { name: "Current user token" })).toBeNull();
    await app.user.click(getByRole(dialog, "button", { name: "Cancel" }));
    expect(queryByRole(document.body, "dialog", { name: "End current access?" })).toBeNull();
    expect(getByRole(document.body, "button", { name: "Continue on another device" })).toBeInstanceOf(
        HTMLButtonElement,
    );
});

test("Given current Morty access, When ending succeeds, Then the setup page confirms this access ended after reloading", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap", identity: true } });
    await app.user.click(await app.queryElementByTestId(dataTestId.closeDialog));
    await app.user.click(getByRole(document.body, "button", { name: "End current access" }));
    const dialog = await app.queryElementByTestId(dataTestId.endRemoteAccessDialog);
    const confirm = await app.waitForView(() => {
        const button = getByRole(dialog, "button", { name: "End current access" });
        expect(button.hasAttribute("disabled")).toBe(false);
        return button;
    });
    await app.user.click(confirm);
    await app.waitForView(() => expect(window.location.search).not.toContain("identity="));
    await app.close();

    const reloaded = await createTestApp({ page: { kind: "bootstrap" } });
    await reloaded.waitForView(() =>
        expect(getByRole(document.body, "status").textContent).toContain("Current access ended"),
    );
    expect(document.body.textContent).toContain("Your local agent and tasks keep running");
    expect(
        getByRole(document.body, "heading", { name: "Continue your coding session from your phone." }),
    ).toBeInstanceOf(HTMLElement);
    await reloaded.close();
    const nextVisit = await createTestApp({ page: { kind: "bootstrap" } });
    await nextVisit.waitForView(() =>
        getByRole(document.body, "heading", { name: "Continue your coding session from your phone." }),
    );
    expect(queryByRole(document.body, "status")).toBeNull();
});

test("Given the end confirmation, When the real API transport closes, Then an uncertain result is shown without claiming the access ended", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap", identity: true }, connectAgent: true });
    await app.user.click(
        await app.waitForView(() => getByRole(document.body, "button", { name: "End current access" })),
    );
    const dialog = await app.queryElementByTestId(dataTestId.endRemoteAccessDialog);
    const confirm = await app.waitForView(() => {
        const button = getByRole(dialog, "button", { name: "End current access" });
        expect(button.hasAttribute("disabled")).toBe(false);
        return button;
    });
    app.transport.close();
    const connectionNotice = await app.waitForView(() =>
        getByRole(document.body, "dialog", { name: "Runtime connection unavailable" }),
    );
    await app.user.click(getByRole(connectionNotice, "button", { name: "Close dialog" }));
    await app.user.click(confirm);

    await app.waitForView(() =>
        expect(getByRole(dialog, "alert").textContent).toContain("We couldn't confirm whether this access ended"),
    );
    expect(getByRole(dialog, "button", { name: "Try again" })).toBeInstanceOf(HTMLButtonElement);
    expect(window.location.search).toContain("identity=");
    expect(document.body.textContent).not.toContain("Current access ended");
    app.transport.open();
    await app.user.click(getByRole(dialog, "button", { name: "Try again" }));
    await app.waitForView(() => expect(window.location.search).not.toContain("identity="));
});

test("Given an end confirmation for revoked access, When the API rejects the request, Then Morty explains the rejection instead of reporting success", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap", identity: true }, connectAgent: true });
    await app.user.click(
        await app.waitForView(() => getByRole(document.body, "button", { name: "End current access" })),
    );
    const dialog = await app.queryElementByTestId(dataTestId.endRemoteAccessDialog);
    const confirm = await app.waitForView(() => {
        const button = getByRole(dialog, "button", { name: "End current access" });
        expect(button.hasAttribute("disabled")).toBe(false);
        return button;
    });
    const signal = new AbortController().signal;
    const revoked = await app.transport.fetch(
        new Request(`${app.origin}/morty/api/projects/${app.identity.projectId}/identity/remote-access`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${await app.identity.getToken(signal)}` },
            signal,
        }),
    );
    expect(revoked.status).toBe(204);
    await app.user.click(confirm);
    await app.waitForView(() =>
        expect(getByRole(dialog, "alert").textContent).toContain("This request was not authorized"),
    );
    expect(dialog.textContent).toContain("Reload Morty to check your current access");
    expect(document.body.textContent).not.toContain("Current access ended");
});

test("Given an unavailable connection, When current access cannot be prepared, Then the user sees a retryable error and can return to confirmation", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap", identity: true }, connectAgent: true });
    const endAccess = await app.waitForView(() => getByRole(document.body, "button", { name: "End current access" }));
    app.transport.close();
    const connectionNotice = await app.waitForView(() =>
        getByRole(document.body, "dialog", { name: "Runtime connection unavailable" }),
    );
    await app.user.click(getByRole(connectionNotice, "button", { name: "Close dialog" }));
    await app.user.click(endAccess);
    const dialog = await app.queryElementByTestId(dataTestId.endRemoteAccessDialog);
    await app.waitForView(() =>
        expect(getByRole(dialog, "alert").textContent).toContain("Couldn't prepare to end this access"),
    );
    app.transport.open();
    await app.user.click(getByRole(dialog, "button", { name: "Try again" }));
    await app.waitForView(() =>
        expect(getByRole(dialog, "button", { name: "End current access" }).hasAttribute("disabled")).toBe(false),
    );
    await app.user.click(getByRole(dialog, "button", { name: "Cancel" }));
    expect(window.location.search).toContain("identity=");
});

test("Given the failure page after a redeemed Morty access, When the user chooses Go to Morty, Then Morty opens home with that access instead of the failed session", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        agent: { id: "pi", label: "Pi" },
        connectAgent: true,
        page: {
            harness: "pi",
            kind: "continue",
            sessionId: "01a0d270-0d62-7003-98df-22a5d11dc644",
        },
    });
    await app.waitForView(() => getByRole(document.body, "alert"));

    await app.user.click(getByRole(document.body, "button", { name: "Go to Morty" }));

    expect(window.location.pathname).toBe("/");
    const destination = new URL(window.location.href);
    expect(destination.searchParams.get("identity")).toBe(
        encodeIdentityScope({ botId: app.botId, projectId: app.identity.projectId, userId: app.userId }),
    );
    expect(destination.searchParams.get("sessionId")).toBeNull();
    expect(destination.searchParams.get("harness")).toBeNull();
    expect(destination.hash).toBe("");

    const home = await app.reload();
    expect(await home.queryElementByTestId(dataTestId.chatLanding)).toBeInstanceOf(HTMLElement);
    expect(queryByRole(document.body, "status", { name: "Opening session" })).toBeNull();
});

test("Given the access was redeemed and its transfer link later stopped working, When the page redeems again, Then the user still enters Morty home with the redeemed access", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        agent: { id: "pi", label: "Pi" },
        connectAgent: true,
        page: {
            harness: "pi",
            kind: "continue",
            sessionId: "01a0d270-0d62-7003-98df-22a5d11dc644",
        },
    });
    await app.waitForView(() => getByRole(document.body, "alert"));
    const redeemedScope = new URL(window.location.href).searchParams.get("identity");
    expect(redeemedScope).not.toBeNull();

    window.location.hash = `code=mobius_transfer_v2.${app.identity.projectId}.${"a".repeat(43)}`;
    app.remount();

    const alert = await app.waitForView(() => getByRole(document.body, "alert"));
    expect(alert.textContent).toContain("The native session was not found");
    await app.user.click(getByRole(document.body, "button", { name: "Go to Morty" }));

    expect(window.location.pathname).toBe("/");
    expect(new URL(window.location.href).searchParams.get("identity")).toBe(redeemedScope);

    const home = await app.reload();
    expect(await home.queryElementByTestId(dataTestId.chatLanding)).toBeInstanceOf(HTMLElement);
});

for (const segments of [0, 4, 8]) {
    test.skipIf(segments === 8 && process.platform !== "linux")(
        `Given a setup handoff carries a ${segments > 0 ? `${segments}-segment multibyte` : "short"} project directory, When the original session is unavailable and I enter Morty, Then the validated directory is selected and remembered`,
        {
            timeout: 30_000,
        },
        async () => {
            const root = await realpath(await mkdtemp(join(tmpdir(), "morty-handoff-project-")));
            const directory = join(
                root,
                ...Array.from({ length: segments }, () => "\u00e9".repeat(segments === 8 ? 110 : 90)),
            );
            try {
                await mkdir(directory, { recursive: true });
                const app = await createTestApp({
                    connectAgent: true,
                    agent: { id: "codex", label: "Codex" },
                    page: {
                        kind: "continue",
                        harness: "codex",
                        sessionId: "native-project-session",
                        workspace: directory,
                    },
                });
                await app.waitForView(() =>
                    expect(getByRole(document.body, "alert").textContent).toContain("The native session was not found"),
                );
                await app.user.click(getByRole(document.body, "button", { name: "Go to Morty" }));
                const continued = await app.reload();
                await continued.user.click(
                    await continued.waitForView(() => getByRole(document.body, "button", { name: "New Session" })),
                );
                expect((await continued.queryElementByTestId(dataTestId.workingDirectory)).textContent).toContain(
                    directory.split("/").at(-1),
                );
                await continued.user.click(continued.elementByTestId(dataTestId.workingDirectory));
                expect((await continued.queryElementByTestId(dataTestId.recentWorkingDirectory)).textContent).toContain(
                    directory,
                );
                await continued.user.click(continued.elementByTestId(dataTestId.changeWorkingDirectory));
                const path = await continued.queryElementByTestId(dataTestId.workingDirectoryPath);
                if (!(path instanceof HTMLInputElement)) {
                    throw new Error("Expected working directory path input");
                }
                expect(path.value).toBe(directory);
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        },
    );
}

test("Given a handoff requests a missing directory, When it opens, Then the Runtime reports the directory failure before continuing the session", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        connectAgent: true,
        agent: { id: "codex", label: "Codex" },
        nativeSessionIds: new Set(["native-directory-session"]),
        page: {
            kind: "continue",
            harness: "codex",
            sessionId: "native-directory-session",
            workspace: join(tmpdir(), `missing-handoff-directory-${crypto.randomUUID()}`),
        },
    });
    const alert = await app.waitForView(() => getByRole(document.body, "alert"));
    expect(alert.textContent).toContain("This directory is missing or unavailable");
    expect(getByRole(document.body, "button", { name: "Try again" })).toBeInstanceOf(HTMLButtonElement);
    expect(window.location.pathname).toBe("/continue");
});

for (const segment of ["a".repeat(220), "\u00e9".repeat(110)]) {
    test(`Given a handoff path over 1533 UTF-8 bytes with ${segment.charCodeAt(0)} characters, When the directory does not exist, Then the request reaches the Runtime's filesystem validation`, {
        timeout: 30_000,
    }, async () => {
        const workspace = join(tmpdir(), `missing-${crypto.randomUUID()}`, ...Array.from({ length: 8 }, () => segment));
        expect(new TextEncoder().encode(workspace).length).toBeGreaterThan(1533);
        const app = await createTestApp({
            connectAgent: true,
            agent: { id: "codex", label: "Codex" },
            page: { kind: "continue", harness: "codex", sessionId: "native-directory-session", workspace },
        });
        const alert = await app.waitForView(() => getByRole(document.body, "alert"));
        expect(alert.textContent).toContain("This directory is missing or unavailable");
    });
}
