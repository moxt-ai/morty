import { getAllByRole, getByRole, getByTitle, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { WebSocketApiTransport } from "../src/services/api/websocket-api-transport.ts";
import { encodeIdentityScope } from "../src/services/identity/identity-scope-url.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

async function startConversation(app: TestApp, prompt: string): Promise<string> {
    const composer = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, prompt);
    await app.waitForView(() =>
        expect(
            app.elementsByTestId(dataTestId.agentResponse).some((entry) => entry.textContent?.includes(prompt)),
        ).toBe(true),
    );
    const sessionId = new URL(window.location.href).searchParams.get("sessionId");
    if (sessionId === null) {
        throw new Error("The opened conversation must have an address");
    }
    return sessionId;
}

test("Given two remembered computers, When I return and then switch, Then the last computer and each computer's own conversation are restored", {
    timeout: 30_000,
}, async () => {
    const first = await createTestApp({ connectAgent: true });
    const firstSession = await startConversation(first, "Work on computer A");
    const firstScope = encodeIdentityScope({
        botId: first.botId,
        projectId: first.identity.projectId,
        userId: first.userId,
    });
    await first.close();
    const second = await createTestApp({ connectAgent: true });
    const secondSession = await startConversation(second, "Work on computer B");
    window.location.href = `${second.origin}/chat`;
    const returned = await second.reload();
    await returned.waitForView(() =>
        expect(new URL(window.location.href).searchParams.get("sessionId")).toBe(secondSession),
    );
    const switcher = await returned.waitForView(() => getByRole(document.body, "button", { name: /Switch computer/ }));
    await returned.user.click(switcher);
    const firstLink = await returned.waitForView(() => {
        const item = getAllByRole(document.body, "menuitem").find(
            (item) =>
                new URL(item.getAttribute("href") ?? "/", returned.origin).searchParams.get("identity") === firstScope,
        );
        if (!(item instanceof HTMLAnchorElement)) {
            throw new Error("Waiting for computer A");
        }
        return item;
    });
    expect(new URL(firstLink.href).searchParams.get("sessionId")).toBe(firstSession);
    expect(firstLink.textContent).toContain("workspace");
    expect(firstLink.textContent).not.toContain("/workspace");
    const directory = getByTitle(firstLink, /\/workspace$/u);
    expect(directory?.textContent).toBe("workspace");
    expect(directory?.getAttribute("title")).toMatch(/\/workspace$/u);
    const computers = getAllByRole(document.body, "menuitem").filter((item) => item.getAttribute("href") !== "/setup");
    expect(computers[0]?.getAttribute("aria-current")).toBe("true");
    expect(computers[0]?.querySelector(".sr-only")?.textContent).toBe("Online");
    window.location.href = firstLink.href;
    const switched = await returned.reload();
    await switched.waitForView(() =>
        expect(
            switched
                .elementsByTestId(dataTestId.agentResponse)
                .some((item) => item.textContent?.includes("Work on computer A")),
        ).toBe(true),
    );
    expect(new URL(window.location.href).searchParams.get("identity")).toBe(firstScope);
});

test("Given a remembered computer, When I deliberately start a new conversation then return, Then its chat home stays selected", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await startConversation(app, "An earlier conversation");
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    window.location.href = `${app.origin}/`;
    const returned = await app.reload();
    await returned.waitForView(() => getByRole(document.body, "textbox", { name: "Message" }));
    expect(new URL(window.location.href).searchParams.has("sessionId")).toBe(false);
    expect(returned.elementsByTestId(dataTestId.agentResponse)).toHaveLength(0);
});

test("Given a remembered computer, When I open an invalid explicit computer link, Then it never switches me to the remembered computer automatically", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await startConversation(app, "Stay on the intended computer");
    window.location.href = `${app.origin}/chat?identity=invalid`;
    const invalid = await app.reload();
    await invalid.waitForView(() => getByRole(document.body, "heading", { name: "This link is no longer valid" }));
    expect(queryByRole(document.body, "textbox", { name: "Message" })).toBeNull();
    expect(getByRole(document.body, "link", { name: "Continue on your last computer" }).getAttribute("href")).toBe("/");
    expect(new URL(window.location.href).searchParams.get("identity")).toBe("invalid");
});

test("Given a remembered computer, When I connect another computer, Then setup remains reachable and returning keeps my original conversation", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const sessionId = await startConversation(app, "Keep this computer available");
    await app.user.click(await app.waitForView(() => getByRole(document.body, "button", { name: /Switch computer/ })));
    const setup = getByRole(document.body, "menuitem", { name: "Connect another computer" });
    expect(setup.getAttribute("href")).toBe("/setup");
    window.location.href = `${app.origin}/setup`;
    const instruction = await app.reload();
    await instruction.waitForView(() => getByRole(document.body, "heading", { name: "Connect another computer" }));
    expect(getByRole(document.body, "link", { name: "← Back to your last computer" }).getAttribute("href")).toBe("/");
    window.location.href = `${app.origin}/`;
    const returned = await instruction.reload();
    await returned.waitForView(() =>
        expect(new URL(window.location.href).searchParams.get("sessionId")).toBe(sessionId),
    );
});

async function revokeAccess(app: TestApp): Promise<void> {
    const signal = AbortSignal.timeout(10_000);
    const response = await app.transport.fetch(
        new Request(`${app.origin}/morty/api/projects/${app.identity.projectId}/identity/remote-access`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${await app.identity.getToken(signal)}` },
            signal,
        }),
    );
    expect(response.status).toBe(204);
}

test("Given the last computer's access ended, When I return through the plain address, Then the next valid computer opens", {
    timeout: 30_000,
}, async () => {
    const first = await createTestApp({ connectAgent: true });
    const firstSession = await startConversation(first, "The remaining computer");
    await first.close();
    const second = await createTestApp({ connectAgent: true });
    await startConversation(second, "The revoked computer");
    await revokeAccess(second);
    window.location.href = `${second.origin}/`;
    const returned = await second.reload();
    await returned.waitForView(() =>
        expect(new URL(window.location.href).searchParams.get("sessionId")).toBe(firstSession),
    );
    await returned.waitForView(() =>
        expect(
            returned
                .elementsByTestId(dataTestId.agentResponse)
                .some((item) => item.textContent?.includes("The remaining computer")),
        ).toBe(true),
    );
});

test("Given a revoked explicit computer link and another saved computer, When I open the link, Then only a deliberate fallback is offered", {
    timeout: 30_000,
}, async () => {
    const first = await createTestApp({ connectAgent: true });
    await startConversation(first, "Another valid computer");
    await first.close();
    const second = await createTestApp({ connectAgent: true });
    await startConversation(second, "Explicit revoked computer");
    await revokeAccess(second);
    const returned = await second.reload();
    await returned.waitForView(() => getByRole(document.body, "heading", { name: "This link is no longer valid" }));
    expect(getByRole(document.body, "link", { name: "Continue on your last computer" })).toBeInstanceOf(
        HTMLAnchorElement,
    );
    expect(queryByRole(document.body, "textbox", { name: "Message" })).toBeNull();
});

test("Given the last computer is offline and another is online, When I return, Then I stay on the offline computer and can explicitly switch", {
    timeout: 30_000,
}, async () => {
    const first = await createTestApp({ connectAgent: true });
    const firstSession = await startConversation(first, "Online computer");
    await first.close();
    const second = await createTestApp({ connectAgent: true });
    const secondSession = await startConversation(second, "Offline computer");
    if (second.daemon === null) {
        throw new Error("Expected a daemon");
    }
    await second.daemon.disconnect();
    window.location.href = `${second.origin}/`;
    const returned = await second.reload();
    await returned.user.click(
        await returned.waitForView(() => getByRole(document.body, "button", { name: /Switch computer/ })),
    );
    const alternative = await returned.waitForView(() => {
        const choice = getAllByRole(document.body, "menuitem").find(
            (item) =>
                new URL(item.getAttribute("href") ?? "/", returned.origin).searchParams.get("sessionId") ===
                firstSession,
        );
        if (!(choice instanceof HTMLAnchorElement)) {
            throw new Error("Waiting for the other computer");
        }
        expect(choice.textContent).toContain("Online");
        return choice;
    });
    expect(new URL(window.location.href).searchParams.get("sessionId")).toBe(secondSession);
    expect(new URL(alternative.getAttribute("href") ?? "", returned.origin).searchParams.get("sessionId")).toBe(
        firstSession,
    );
    expect(returned.elementByTestId(dataTestId.botConnectionStatus).getAttribute("data-connection-status")).toBe(
        "disconnected",
    );
});

test("Given only a legacy credential, When I open the plain address, Then Morty asks for the original link once and remembers it afterwards", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await startConversation(app, "Existing user");
    const originalLink = window.location.href;
    // Simulate an existing browser from before computer metadata was introduced.
    window.localStorage.removeItem("morty:remembered-computers:v1");
    window.location.href = `${app.origin}/`;
    const legacy = await app.reload();
    await legacy.waitForView(() =>
        expect(document.body.textContent).toContain("Open the link your agent gave you once"),
    );
    window.location.href = originalLink;
    const linked = await legacy.reload();
    await linked.waitForView(() => getByRole(document.body, "textbox", { name: "Message" }));
    window.location.href = `${app.origin}/`;
    const returned = await linked.reload();
    await returned.waitForView(() => getByRole(document.body, "textbox", { name: "Message" }));
    expect(document.body.textContent).not.toContain("Open the link your agent gave you once");
});

test("Given only a legacy credential whose access was revoked, When I open its link and then the plain address, Then Morty stops asking for that link", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await startConversation(app, "Revoked legacy user");
    const originalLink = window.location.href;
    // Simulate an existing browser from before computer metadata was introduced.
    window.localStorage.removeItem("morty:remembered-computers:v1");
    await revokeAccess(app);
    const linked = await app.reload();
    await linked.waitForView(() => getByRole(document.body, "heading", { name: "This link is no longer valid" }));
    expect(window.location.href).toBe(originalLink);
    window.location.href = `${app.origin}/`;
    const returned = await linked.reload();
    await returned.waitForView(() => getByRole(document.body, "heading", { name: "Connect your agent to Morty" }));
    expect(document.body.textContent).not.toContain("Open the link your agent gave you once");
});

test("Given a saved computer and a failed connection, When I retry after reconnecting, Then my original conversation is retained", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const sessionId = await startConversation(app, "Preserve access through a network failure");
    await app.close();
    window.location.href = `${app.origin}/`;
    // A reload gets its own page transport; the previous one was disposed.
    const transport = new WebSocketApiTransport(app.origin);
    const unavailable = await createTestApp({
        application: { ...app, transport, close: () => transport.dispose() },
        page: { kind: "reload" },
    });
    unavailable.transport.disconnect();
    const retry = await unavailable.waitForView(() => getByRole(document.body, "button", { name: "Retry" }));
    expect(document.body.textContent).toContain("Your saved computers are still here");
    unavailable.transport.open();
    await unavailable.user.click(retry);
    await unavailable.waitForView(() =>
        expect(new URL(window.location.href).searchParams.get("sessionId")).toBe(sessionId),
    );
    await unavailable.waitForView(() => getByRole(document.body, "textbox", { name: "Message" }));
});

test("Given two computers, When I end the current access, Then the other computer opens with its own route and a named confirmation", {
    timeout: 30_000,
}, async () => {
    const first = await createTestApp({ connectAgent: true });
    const firstSession = await startConversation(first, "Surviving computer conversation");
    await first.close();
    const second = await createTestApp({ connectAgent: true });
    await startConversation(second, "Computer to disconnect");
    await second.user.type(
        getByRole(document.body, "textbox", { name: "Message" }),
        "Do not send this draft to the other computer",
    );
    await second.user.click(await second.queryElementByTestId(dataTestId.userMenu));
    await second.user.click(await second.queryElementByTestId(dataTestId.endRemoteAccess));
    const dialog = await second.queryElementByTestId(dataTestId.endRemoteAccessDialog);
    const confirm = await second.waitForView(() => {
        const button = getByRole(dialog, "button", { name: "End current access" });
        expect(button.hasAttribute("disabled")).toBe(false);
        return button;
    });
    await second.user.click(confirm);
    await second.waitForView(() => expect(new URL(window.location.href).searchParams.has("identity")).toBe(false));
    expect(new URL(window.location.href).searchParams.has("sessionId")).toBe(false);
    const returned = await second.reload();
    await returned.waitForView(() =>
        expect(new URL(window.location.href).searchParams.get("sessionId")).toBe(firstSession),
    );
    await returned.waitForView(() =>
        expect(document.body.textContent).toContain("Access to Controlled Agent Runtime ended"),
    );
    const composer = await returned.waitForView(() => getByRole(document.body, "textbox", { name: "Message" }));
    expect(composer).toHaveProperty("value", "");
});

test("Given saved access for the same computer, When an old native handoff link has expired without an identity query, Then that access still opens the intended target", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ agent: { id: "pi", label: "Pi" }, connectAgent: true });
    await startConversation(app, "Keep the issued grant");
    window.location.href = `${app.origin}/continue?harness=pi&sessionId=missing-session#code=mobius_transfer_v2.${app.identity.projectId}.${"a".repeat(43)}`;
    const continued = await app.reload();
    await continued.waitForView(() =>
        expect(getByRole(document.body, "alert").textContent).toContain("The native session was not found"),
    );
    expect(getByRole(document.body, "button", { name: "Go to Morty" })).toBeInstanceOf(HTMLButtonElement);
});

test("Given another saved computer, When a transfer link cannot be redeemed, Then the page offers a secondary explicit fallback without switching", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await startConversation(app, "Do not replace the explicit target");
    await app.close();
    const other = await createTestApp({
        page: {
            kind: "continue",
            harness: "pi",
            sessionId: "missing-session",
            code: (application) => `mobius_transfer_v2.${application.identity.projectId}.${"a".repeat(43)}`,
        },
    });
    await other.waitForView(() =>
        expect(getByRole(document.body, "alert").textContent).toContain("expired or been revoked"),
    );
    expect(getByRole(document.body, "link", { name: "Continue on your last computer" })).toBeInstanceOf(
        HTMLAnchorElement,
    );
    expect(queryByRole(document.body, "button", { name: "Try again" })).toBeNull();
    expect(document.body.textContent).toContain("Run setup again on that computer to get a new link.");
    expect(window.location.pathname).toBe("/continue");
    expect(queryByRole(document.body, "button", { name: "Go to Morty" })).toBeNull();
});

test("Given the remembered conversation was closed elsewhere, When I return, Then the same computer opens at chat home while an explicit stale conversation link still reports failure", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const sessionId = await startConversation(app, "Conversation closed on another device");
    const explicit = window.location.href;
    const signal = AbortSignal.timeout(10_000);
    const archived = await app.transport.fetch(
        new Request(
            `${app.origin}/morty/api/chat/projects/${app.identity.projectId}/bots/${app.botId}/managed-session/archive`,
            {
                method: "POST",
                headers: {
                    authorization: `Bearer ${await app.identity.getToken(signal)}`,
                    "content-type": "application/json",
                },
                body: JSON.stringify({ sessionId }),
                signal,
            },
        ),
    );
    expect(archived.status).toBe(200);
    window.location.href = `${app.origin}/`;
    const restored = await app.reload();
    await restored.waitForView(() => getByRole(document.body, "textbox", { name: "Message" }));
    await restored.waitForView(() => expect(new URL(window.location.href).searchParams.has("sessionId")).toBe(false));
    expect(new URL(window.location.href).searchParams.get("identity")).toBe(
        new URL(explicit).searchParams.get("identity"),
    );
    window.location.href = explicit;
    const linked = await restored.reload();
    await linked.waitForView(() => expect(document.body.textContent).toContain("Your Chat session was not found"));
    expect(new URL(window.location.href).searchParams.get("sessionId")).toBe(sessionId);
});

test("Given the last computer was deleted, When I return, Then the next valid computer opens and the deleted one is not offered", {
    timeout: 30_000,
}, async () => {
    const first = await createTestApp({ connectAgent: true });
    const firstSession = await startConversation(first, "Keep the existing computer");
    await first.close();
    const second = await createTestApp({ connectAgent: true });
    await startConversation(second, "Deleted computer");
    const deletedScope = new URL(window.location.href).searchParams.get("identity");
    const signal = AbortSignal.timeout(10_000);
    const replacement = await second.transport.fetch(
        new Request(`${second.origin}/morty/api/projects/${second.identity.projectId}/management/bots`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${await second.identity.getToken(signal)}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({ displayName: "A replacement outside this browser" }),
            signal,
        }),
    );
    expect(replacement.status).toBe(201);
    const deleted = await second.transport.fetch(
        new Request(
            `${second.origin}/morty/api/projects/${second.identity.projectId}/management/bots/${second.botId}`,
            {
                method: "DELETE",
                headers: { authorization: `Bearer ${await second.identity.getToken(signal)}` },
                signal,
            },
        ),
    );
    expect(deleted.status).toBe(204);
    window.location.href = `${second.origin}/`;
    const returned = await second.reload();
    await returned.waitForView(() =>
        expect(new URL(window.location.href).searchParams.get("sessionId")).toBe(firstSession),
    );
    await returned.user.click(
        await returned.waitForView(() => getByRole(document.body, "button", { name: /Switch computer/ })),
    );
    await returned.waitForView(() => expect(document.body.textContent).not.toContain("Checking connections"));
    expect(
        getAllByRole(document.body, "menuitem").some(
            (item) =>
                new URL(item.getAttribute("href") ?? "/", returned.origin).searchParams.get("identity") ===
                deletedScope,
        ),
    ).toBe(false);
});

test("Given a computer I keep using, When ten more computers are saved in this browser, Then its link still opens and older unused computers make room", {
    timeout: 120_000,
}, async () => {
    const daily = await createTestApp({ connectAgent: true });
    const dailySession = await startConversation(daily, "My daily computer");
    const dailyLink = window.location.href;
    const dailyScope = new URL(dailyLink).searchParams.get("identity");
    await daily.close();
    const openShared = async (): Promise<TestApp> => {
        const shared = await createTestApp({ page: { kind: "share" } });
        const scope = encodeIdentityScope({
            botId: shared.botId,
            projectId: shared.identity.projectId,
            userId: shared.userId,
        });
        await shared.waitForView(() => expect(new URL(window.location.href).searchParams.get("identity")).toBe(scope));
        // The redeemed link replaces the page, which then opens that computer and asks to connect its agent.
        const opened = await shared.reload();
        await opened.waitForView(() => getByRole(document.body, "dialog", { name: "Connect agent" }));
        return opened;
    };
    const openDaily = async (app: TestApp): Promise<TestApp> => {
        window.location.href = dailyLink;
        const opened = await app.reload();
        await opened.waitForView(() => getByRole(document.body, "button", { name: /Switch computer/ }));
        expect(new URL(window.location.href).searchParams.get("sessionId")).toBe(dailySession);
        return opened;
    };

    // The browser fills up with computers, and the daily one is used again before the last is saved.
    let shared = await openShared();
    const oldestScope = new URL(window.location.href).searchParams.get("identity");
    for (let saved = 1; saved < 9; saved += 1) {
        await shared.close();
        shared = await openShared();
    }
    await (await openDaily(shared)).close();
    shared = await openShared();

    // The daily computer is the most recently used of the computers before the last, so it keeps its access.
    const returned = await openDaily(shared);
    await returned.user.click(
        await returned.waitForView(() => getByRole(document.body, "button", { name: /Switch computer/ })),
    );
    await returned.waitForView(() => expect(document.body.textContent).not.toContain("Checking connections"));
    const offered = getAllByRole(document.body, "menuitem").map((item) =>
        new URL(item.getAttribute("href") ?? "/", returned.origin).searchParams.get("identity"),
    );
    expect(offered).toContain(dailyScope);
    expect(offered).not.toContain(oldestScope);
    expect(offered.filter((scope) => scope !== null)).toHaveLength(10);
});

// Another Morty version can store access this version cannot read, such as a newer token format.
const FUTURE_USER_ID = "usr_saved-by-a-newer-version";
const FUTURE_TOKEN = `mobius_anon_v3_${"f".repeat(43)}`;

function addStoredValue(key: string, add: (stored: unknown) => unknown): void {
    const raw = window.localStorage.getItem(key);
    window.localStorage.setItem(key, JSON.stringify(add(raw === null ? null : JSON.parse(raw))));
}

test("Given a remembered computer and a credential this version cannot read, When I return through the plain address, Then my computer opens and the other credential is kept", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const sessionId = await startConversation(app, "Keep my computer");
    addStoredValue("mobius.anonymous-credentials.v1", (stored) => ({
        ...(typeof stored === "object" && stored !== null ? stored : {}),
        [FUTURE_USER_ID]: FUTURE_TOKEN,
    }));

    window.location.href = `${app.origin}/`;
    const returned = await app.reload();
    await returned.waitForView(() => getByRole(document.body, "button", { name: /Switch computer/ }));
    expect(new URL(window.location.href).searchParams.get("sessionId")).toBe(sessionId);
    // Opening the computer saved its visit; the credential this version cannot read is still there for the other.
    expect(JSON.parse(window.localStorage.getItem("mobius.anonymous-credentials.v1") ?? "{}")).toMatchObject({
        [FUTURE_USER_ID]: FUTURE_TOKEN,
    });
});

test("Given a remembered computer and a computer record this version cannot read, When I return through the plain address, Then my computer opens and the other record is kept", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const sessionId = await startConversation(app, "Keep my computer list");
    const future = { scope: { userId: FUTURE_USER_ID }, destination: { kind: "workspace" }, lastUsedAt: 0 };
    addStoredValue("morty:remembered-computers:v1", (stored) => [...(Array.isArray(stored) ? stored : []), future]);

    window.location.href = `${app.origin}/`;
    const returned = await app.reload();
    await returned.waitForView(() => getByRole(document.body, "button", { name: /Switch computer/ }));
    expect(new URL(window.location.href).searchParams.get("sessionId")).toBe(sessionId);
    expect(JSON.parse(window.localStorage.getItem("morty:remembered-computers:v1") ?? "[]")).toContainEqual(future);
});

test("Given a computer record this version cannot read whose token it can read, When saving a visit has to make room for tokens, Then that computer keeps its token", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const sessionId = await startConversation(app, "Keep the other version's computer");
    const theirToken = `mobius_anon_v2_${"t".repeat(43)}`;
    const future = { scope: { userId: FUTURE_USER_ID }, destination: { kind: "workspace" }, lastUsedAt: 0 };
    addStoredValue("morty:remembered-computers:v1", (stored) => [...(Array.isArray(stored) ? stored : []), future]);
    // Its token comes first, and older tokens no computer claims fill the remaining room.
    addStoredValue("mobius.anonymous-credentials.v1", (stored) => ({
        [FUTURE_USER_ID]: theirToken,
        ...(typeof stored === "object" && stored !== null ? stored : {}),
        ...Object.fromEntries(
            Array.from({ length: 9 }, (_, index) => [
                `usr_unclaimed-${index}`,
                `mobius_anon_v2_${String(index).repeat(43)}`,
            ]),
        ),
    }));

    window.location.href = `${app.origin}/`;
    const returned = await app.reload();
    await returned.waitForView(() => getByRole(document.body, "button", { name: /Switch computer/ }));
    expect(new URL(window.location.href).searchParams.get("sessionId")).toBe(sessionId);
    const credentials = JSON.parse(window.localStorage.getItem("mobius.anonymous-credentials.v1") ?? "{}");
    expect(credentials).toMatchObject({ [FUTURE_USER_ID]: theirToken });
    expect(Object.keys(credentials)).toHaveLength(10);
});

test("Given a computer whose remembered conversation was closed elsewhere, When I switch to it from another computer, Then it opens at its chat home", {
    timeout: 30_000,
}, async () => {
    const first = await createTestApp({ connectAgent: true });
    const closedSession = await startConversation(first, "Closed on another device");
    const firstScope = encodeIdentityScope({
        botId: first.botId,
        projectId: first.identity.projectId,
        userId: first.userId,
    });
    const signal = AbortSignal.timeout(10_000);
    const archived = await first.transport.fetch(
        new Request(
            `${first.origin}/morty/api/chat/projects/${first.identity.projectId}/bots/${first.botId}/managed-session/archive`,
            {
                method: "POST",
                headers: {
                    authorization: `Bearer ${await first.identity.getToken(signal)}`,
                    "content-type": "application/json",
                },
                body: JSON.stringify({ sessionId: closedSession }),
                signal,
            },
        ),
    );
    expect(archived.status).toBe(200);
    await first.close();
    const second = await createTestApp({ connectAgent: true });
    await startConversation(second, "Work on the other computer");

    await second.user.click(
        await second.waitForView(() => getByRole(document.body, "button", { name: /Switch computer/ })),
    );
    const firstLink = await second.waitForView(() => {
        const item = getAllByRole(document.body, "menuitem").find(
            (item) =>
                new URL(item.getAttribute("href") ?? "/", second.origin).searchParams.get("identity") === firstScope,
        );
        if (!(item instanceof HTMLAnchorElement)) {
            throw new Error("Waiting for the first computer");
        }
        return item;
    });
    window.location.href = firstLink.href;
    const switched = await second.reload();
    await switched.waitForView(() => getByRole(document.body, "textbox", { name: "Message" }));
    await switched.waitForView(() => expect(new URL(window.location.href).searchParams.has("sessionId")).toBe(false));
    expect(new URL(window.location.href).searchParams.get("identity")).toBe(firstScope);
    expect(document.body.textContent).not.toContain("Your Chat session was not found");
});

test("Given a switch to a computer whose remembered conversation is gone, When opening the computer fails once and I retry, Then it still opens at its chat home", {
    timeout: 30_000,
}, async () => {
    const first = await createTestApp({ connectAgent: true });
    const closedSession = await startConversation(first, "Closed before a failed switch");
    const signal = AbortSignal.timeout(10_000);
    const archived = await first.transport.fetch(
        new Request(
            `${first.origin}/morty/api/chat/projects/${first.identity.projectId}/bots/${first.botId}/managed-session/archive`,
            {
                method: "POST",
                headers: {
                    authorization: `Bearer ${await first.identity.getToken(signal)}`,
                    "content-type": "application/json",
                },
                body: JSON.stringify({ sessionId: closedSession }),
                signal,
            },
        ),
    );
    expect(archived.status).toBe(200);
    await first.close();
    const second = await createTestApp({ connectAgent: true });
    await startConversation(second, "Work before the failed switch");
    await second.user.click(
        await second.waitForView(() => getByRole(document.body, "button", { name: /Switch computer/ })),
    );
    const firstScope = encodeIdentityScope({
        botId: first.botId,
        projectId: first.identity.projectId,
        userId: first.userId,
    });
    const firstLink = await second.waitForView(() => {
        const item = getAllByRole(document.body, "menuitem").find(
            (item) =>
                new URL(item.getAttribute("href") ?? "/", second.origin).searchParams.get("identity") === firstScope,
        );
        if (!(item instanceof HTMLAnchorElement)) {
            throw new Error("Waiting for the first computer");
        }
        return item;
    });
    await second.close();

    // The switched-to page loses its connection while it opens the computer.
    window.location.href = firstLink.href;
    const transport = new WebSocketApiTransport(second.origin);
    const unavailable = await createTestApp({
        application: { ...second, transport, close: () => transport.dispose() },
        page: { kind: "reload" },
    });
    unavailable.transport.disconnect();
    const retry = await unavailable.waitForView(() => getByRole(document.body, "button", { name: "Retry" }));
    unavailable.transport.open();
    await unavailable.user.click(retry);

    await unavailable.waitForView(() => getByRole(document.body, "textbox", { name: "Message" }));
    await unavailable.waitForView(() =>
        expect(new URL(window.location.href).searchParams.has("sessionId")).toBe(false),
    );
    expect(new URL(window.location.href).searchParams.get("identity")).toBe(firstScope);
    expect(document.body.textContent).not.toContain("Your Chat session was not found");
});
