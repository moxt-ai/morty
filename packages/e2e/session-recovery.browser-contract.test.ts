import { createServer, request } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { WebSocket } from "playwright-core";
import { dataTestId } from "../web/src/data-testid.ts";
import { test as base, expect } from "./infra/test.ts";

type Network = {
    readonly url: string;
    readonly blackhole: (route: "all" | "session" | "bridge") => void;
    readonly disconnect: () => void;
    readonly interruptSession: () => void;
    readonly stallSessionRequests: () => void;
    readonly resumeSessionRequests: () => void;
    readonly restore: () => void;
};

const test = base.extend<{ readonly network: Network }>({
    network: async ({ browserName }, use) => {
        if (browserName !== "webkit") {
            throw new Error("These recovery contracts target mobile WebKit");
        }
        // Forward real HTTP/WebSocket traffic. The fault destroys TCP sockets
        // and stalls new upgrades; it never supplies application responses.
        let offline = false;
        const tunnels = new Set<{
            readonly client: Duplex;
            readonly upstream: Socket;
            readonly route: "session" | "bridge";
        }>();
        const sockets = new Set<Socket>();
        const server = createServer((incoming, outgoing) => {
            if (offline) {
                return;
            }
            const endpoint = new URL(incoming.url ?? "");
            const upstream = request(endpoint, { method: incoming.method, headers: incoming.headers }, (response) => {
                outgoing.writeHead(response.statusCode ?? 502, response.headers);
                response.pipe(outgoing);
            });
            upstream.on("error", () => outgoing.destroy());
            incoming.pipe(upstream);
        });
        server.on("connection", (socket) => {
            sockets.add(socket);
            socket.on("error", () => undefined);
            socket.on("close", () => sockets.delete(socket));
        });
        server.on("upgrade", (incoming, client, head) => {
            if (offline) {
                return;
            }
            const endpoint = new URL(incoming.url ?? "", `http://${incoming.headers.host}`);
            const upstream = connect(Number(endpoint.port) || 80, endpoint.hostname, () => {
                const headers = Object.entries(incoming.headers)
                    .filter(([, value]) => value !== undefined)
                    .map(([name, value]) => `${name}: ${value}`)
                    .join("\r\n");
                upstream.write(
                    `${incoming.method} ${endpoint.pathname}${endpoint.search} HTTP/1.1\r\n${headers}\r\n\r\n`,
                );
                upstream.write(head);
                client.pipe(upstream).pipe(client);
            });
            const tunnel = {
                client,
                upstream,
                route: endpoint.pathname === "/morty/ws" ? ("bridge" as const) : ("session" as const),
            };
            tunnels.add(tunnel);
            sockets.add(upstream);
            upstream.on("error", () => client.destroy());
            upstream.on("close", () => {
                tunnels.delete(tunnel);
                sockets.delete(upstream);
                client.destroy();
            });
            client.on("close", () => upstream.destroy());
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (address === null || typeof address === "string") {
            throw new Error("Missing network proxy address");
        }
        try {
            await use({
                url: `http://127.0.0.1:${address.port}`,
                blackhole: (route) => {
                    for (const tunnel of tunnels) {
                        if (route === "all" || tunnel.route === route) {
                            tunnel.client.pause();
                            tunnel.upstream.pause();
                        }
                    }
                },
                disconnect: () => {
                    offline = true;
                    for (const socket of sockets) {
                        socket.destroy();
                    }
                },
                interruptSession: () => {
                    for (const tunnel of tunnels) {
                        if (tunnel.route === "session") {
                            tunnel.client.destroy();
                        }
                    }
                },
                stallSessionRequests: () => {
                    for (const tunnel of tunnels) {
                        if (tunnel.route === "session") {
                            // Stall requests while keeping server-to-browser events and heartbeats flowing.
                            tunnel.client.pause();
                        }
                    }
                },
                resumeSessionRequests: () => {
                    for (const tunnel of tunnels) {
                        if (tunnel.route === "session") {
                            tunnel.client.resume();
                        }
                    }
                },
                restore: () => {
                    offline = false;
                    for (const socket of sockets) {
                        socket.destroy();
                    }
                },
            });
        } finally {
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    },
    contextOptions: async ({ network }, use) => {
        await use({
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
            proxy: { server: network.url },
        });
    },
});

test.use({
    browserName: "webkit",
});

test("Given a healthy conversation, when the stability timer and foreground signals arrive together, then it keeps its connection without an error", async ({
    runtime,
}) => {
    const { page } = runtime;
    let connections = 0;
    page.on("websocket", (socket) => {
        if (new URL(socket.url()).pathname.endsWith("/transport")) {
            connections += 1;
        }
    });
    await page.clock.install({ time: new Date("2026-10-24T00:00:00Z") });
    const connected = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    await page.goto(connected.url);
    const composer = page.getByRole("textbox", { name: "Message" });
    await expect(composer).toBeEnabled();
    await composer.fill("Establish a healthy conversation.");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("article", { name: "Agent response" })).toContainText(
        "Establish a healthy conversation.",
    );
    await composer.fill("Keep this draft across a healthy resume.");
    const before = connections;
    await page.clock.runFor(25000);
    await page.evaluate(() => {
        document.dispatchEvent(new Event("visibilitychange"));
        document.dispatchEvent(new Event("resume"));
        window.dispatchEvent(new Event("online"));
    });
    await expect(composer).toBeEnabled();
    await expect(page.getByTestId(dataTestId.sessionReconnectNotice)).toBeHidden();
    await expect(composer).toHaveValue("Keep this draft across a healthy resume.");
    // Complete a user-visible round trip before advancing the transport's virtual deadline.
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("article", { name: "Agent response" }).last()).toContainText(
        "Keep this draft across a healthy resume.",
    );
    await page.clock.runFor(5000);
    await expect(composer).toBeEnabled();
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(connections).toBe(before);
});

test("Given an interrupted browser connection, when a task completes before foreground recovery, then the interruption stays neutral and its result is restored", async ({
    runtime,
    network,
}, testInfo) => {
    const { page } = runtime;
    const sockets = new Set<WebSocket>();
    page.on("websocket", (socket) => {
        if (new URL(socket.url()).pathname.endsWith("/transport")) {
            sockets.add(socket);
            socket.on("close", () => sockets.delete(socket));
        }
    });
    await page.clock.install({ time: new Date("2026-10-24T00:00:00Z") });
    const connected = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    await page.goto(connected.url);
    const composer = page.getByRole("textbox", { name: "Message" });
    await expect(composer).toBeEnabled();
    await composer.fill("hold after first delta");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("article", { name: "Agent response" })).toContainText("Partial reply");
    await composer.fill("Preserve this unsent draft.");
    const closed = Promise.all(
        [...sockets].map((socket) => new Promise<void>((resolve) => socket.once("close", () => resolve()))),
    );
    network.interruptSession();
    await closed;
    await expect(composer).toBeEnabled();
    await expect(page.getByTestId(dataTestId.sendMessage)).toBeDisabled();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry now", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("recoverable-interruption.png") });
    await runtime.continueReply("hold after first delta", {
        outcome: "complete",
        output: [{ kind: "text", text: "Task finished while the browser was disconnected." }],
    });
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.clock.runFor(5000);
    await expect(composer).toBeEnabled();
    await expect(page.getByTestId(dataTestId.sessionReconnectNotice)).toBeHidden();
    await expect(composer).toHaveValue("Preserve this unsent draft.");
    await expect(
        page
            .getByRole("article", { name: "Agent response" })
            .filter({ hasText: "Task finished while the browser was disconnected." }),
    ).toHaveCount(1);
    await expect(page.getByRole("article", { name: "Your message" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Stop agent output" })).toBeHidden();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("foreground-recovered.png") });
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("article", { name: "Agent response" }).last()).toContainText(
        "Preserve this unsent draft.",
    );
    await expect(page.getByRole("article", { name: "Your message" })).toHaveCount(2);
});

for (const recovery of ["automatic", "online", "manual"] as const) {
    test(`Given an active imported conversation, when ${recovery} recovery follows a network outage, then chat resumes without reloading`, async ({
        runtime,
        network,
    }) => {
        const { page } = runtime;
        const activeSockets = new Set<WebSocket>();
        page.on("websocket", (socket) => {
            activeSockets.add(socket);
            socket.on("close", () => activeSockets.delete(socket));
        });
        await page.clock.install({ time: new Date("2026-10-23T00:00:00Z") });
        const connected = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
        await page.goto(connected.url);
        const composer = page.getByRole("textbox", { name: "Message" });
        await expect(composer).toBeEnabled();
        await composer.fill("Keep this conversation available.");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await expect(page.getByRole("article", { name: "Agent response" })).toContainText(
            "Keep this conversation available.",
        );
        await composer.fill("Preserve my unsent draft.");
        const socketsClosed = Promise.all(
            [...activeSockets].map((socket) => new Promise<void>((resolve) => socket.once("close", () => resolve()))),
        );
        network.disconnect();
        await socketsClosed;
        await expect(composer).toBeEnabled();
        await expect(page.getByTestId(dataTestId.sendMessage)).toBeDisabled();
        await page.clock.runFor(12000);
        if (recovery !== "automatic") {
            // Spend the bounded bridge retry budget before an explicit wakeup.
            await page.clock.runFor(300000);
        }
        network.restore();
        if (recovery === "online") {
            await page.evaluate(() => window.dispatchEvent(new Event("online")));
        } else if (recovery === "manual") {
            await page.getByRole("button", { name: "Retry now", exact: true }).click();
        }
        await page.clock.runFor(6000);
        await expect(composer).toBeEnabled();
        await expect(page.getByTestId(dataTestId.sessionReconnectNotice)).toBeHidden();
        await expect(composer).toHaveValue("Preserve my unsent draft.");
        await expect(page.getByRole("article", { name: "Agent response" })).toHaveCount(1);
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await expect(page.getByRole("article", { name: "Agent response" }).last()).toContainText(
            "Preserve my unsent draft.",
        );
    });
}

for (const route of ["all", "session", "bridge", "suspended"] as const) {
    const condition = route === "suspended" ? "a suspended browser" : `a silently stalled ${route} connection`;
    test(`Given ${condition}, when the browser resumes, then the conversation recovers with its draft and history`, async ({
        runtime,
        network,
    }) => {
        const { page } = runtime;
        await page.clock.install({ time: new Date("2026-10-23T00:00:00Z") });
        await page.clock.pauseAt(new Date("2026-10-23T00:01:00Z"));
        const connected = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
        await page.goto(connected.url);
        const composer = page.getByRole("textbox", { name: "Message" });
        await expect(composer).toBeEnabled();
        await composer.fill("Remember the first response.");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await expect(page.getByRole("article", { name: "Agent response" })).toContainText(
            "Remember the first response.",
        );
        await composer.fill("Continue after resuming.");
        network.blackhole(route === "suspended" ? "all" : route);
        if (route === "suspended") {
            // Resume overdue timers once, as after a long browser suspension.
            await page.clock.fastForward(120000);
        }
        await page.evaluate(() => {
            document.dispatchEvent(new Event("resume"));
            window.dispatchEvent(new Event("online"));
            window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
        });
        if (route === "session" || route === "all") {
            await page.clock.runFor(30000);
            if (route === "session") {
                // Foreground hints must not probe or reset an otherwise-open Session transport.
                await expect(composer).toBeEnabled();
                await expect(page.getByTestId(dataTestId.sendMessage)).toBeEnabled();
                await expect(page.getByTestId(dataTestId.sessionReconnectNotice)).toBeHidden();
            }
            // The existing tunnel stays blackholed until the SDK's 60-second idle deadline.
            await page.clock.runFor(30000);
            await expect(page.getByTestId(dataTestId.sendMessage)).toBeDisabled();
        } else if (route !== "suspended") {
            // Bridge liveness is independent of Session execution-state polling.
            await page.clock.runFor(5000);
        }
        await page.clock.runFor(5000);
        await expect(composer).toBeEnabled();
        await expect(page.getByTestId(dataTestId.sessionReconnectNotice)).toBeHidden();
        await expect(composer).toHaveValue("Continue after resuming.");
        await expect(page.getByRole("article", { name: "Agent response" })).toHaveCount(1);
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await expect(page.getByRole("article", { name: "Agent response" }).last()).toContainText(
            "Continue after resuming.",
        );
    });
}

test("Given a silently stalled session without a lifecycle event, when its liveness deadline expires, then chat becomes usable again", async ({
    runtime,
    network,
}) => {
    const { page } = runtime;
    await page.clock.install({ time: new Date("2026-10-23T00:00:00Z") });
    await page.clock.pauseAt(new Date("2026-10-23T00:01:00Z"));
    const connected = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    await page.goto(connected.url);
    const composer = page.getByRole("textbox", { name: "Message" });
    await expect(composer).toBeEnabled();
    await composer.fill("Establish the conversation before the network stalls.");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("article", { name: "Agent response" }).last()).toContainText(
        "Establish the conversation before the network stalls.",
    );
    await composer.fill("Preserve this draft until transport recovery.");
    network.blackhole("session");
    await page.clock.runFor(30000);
    await expect(page.getByTestId(dataTestId.sendMessage)).toBeEnabled();
    await expect(page.getByTestId(dataTestId.sessionReconnectNotice)).toBeHidden();
    await page.clock.runFor(30000);
    await expect(composer).toBeEnabled();
    await expect(page.getByTestId(dataTestId.sendMessage)).toBeDisabled();
    await page.clock.runFor(5000);
    await expect(composer).toBeEnabled();
    await expect(page.getByTestId(dataTestId.sendMessage)).toBeEnabled();
    await expect(page.getByTestId(dataTestId.sessionReconnectNotice)).toBeHidden();
    await expect(composer).toHaveValue("Preserve this draft until transport recovery.");
    await expect(page.getByRole("article", { name: "Your message" })).toHaveCount(1);
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("article", { name: "Agent response" }).last()).toContainText(
        "Preserve this draft until transport recovery.",
    );
});

test("Given a live Session stream with stalled execution reads, when foreground hints and the former health deadline pass, then the draft stays sendable without reconnecting", async ({
    runtime,
    network,
}) => {
    const { page } = runtime;
    let connections = 0;
    page.on("websocket", (socket) => {
        if (new URL(socket.url()).pathname.endsWith("/transport")) {
            connections += 1;
        }
    });
    await page.clock.install({ time: new Date("2026-10-23T00:00:00Z") });
    await page.clock.pauseAt(new Date("2026-10-23T00:01:00Z"));
    const connected = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    await page.goto(connected.url);
    const composer = page.getByRole("textbox", { name: "Message" });
    await expect(composer).toBeEnabled();
    await composer.fill("Establish a live stream before stalling requests.");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("article", { name: "Agent response" }).last()).toContainText(
        "Establish a live stream before stalling requests.",
    );
    await composer.fill("Keep this draft on the live connection.");
    const before = connections;
    network.stallSessionRequests();
    await page.evaluate(() => {
        document.dispatchEvent(new Event("resume"));
        window.dispatchEvent(new Event("online"));
    });
    await page.clock.runFor(5000);
    await expect(page.getByTestId(dataTestId.sendMessage)).toBeEnabled();
    await expect(page.getByTestId(dataTestId.sessionReconnectNotice)).toBeHidden();
    await page.clock.runFor(20000);
    await page.clock.runFor(10000);
    await expect(page.getByTestId(dataTestId.sendMessage)).toBeEnabled();
    await expect(page.getByTestId(dataTestId.sessionReconnectNotice)).toBeHidden();
    await expect(composer).toHaveValue("Keep this draft on the live connection.");
    await expect(page.getByRole("article", { name: "Your message" })).toHaveCount(1);
    expect(connections).toBe(before);
    network.resumeSessionRequests();
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("article", { name: "Agent response" }).last()).toContainText(
        "Keep this draft on the live connection.",
    );
});

test("Given a mobile browser with an unsent draft, when its network is disabled and restored, then offline feedback and send availability follow the network without losing edits", async ({
    runtime,
}) => {
    const { page } = runtime;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.clock.install({ time: new Date("2026-10-24T00:00:00Z") });
    await runtime.openPairedChat();
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("Keep this draft");
    await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
    await page.context().setOffline(true);
    await expect(page.getByTestId(dataTestId.sessionReconnectNotice)).toContainText("No network connection");
    await expect(composer).toBeEnabled();
    await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
    await composer.fill("Keep this draft and my offline edits");
    await expect(page.getByRole("button", { name: /Switch computer/ })).toHaveAccessibleDescription(
        "No network connection",
    );
    await page.context().setOffline(false);
    await page.clock.runFor(5000);
    await expect(page.getByTestId(dataTestId.sessionReconnectNotice)).toBeHidden();
    await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
    await expect(composer).toHaveValue("Keep this draft and my offline edits");
    await expect(page.getByRole("article", { name: "Your message" })).toHaveCount(0);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("article", { name: "Agent response" })).toContainText(
        "Keep this draft and my offline edits",
    );
});

test("Given an active turn on mobile, when the browser goes offline and the user presses Enter, then the follow-up stays editable and can be queued after recovery", async ({
    runtime,
}) => {
    const { page } = runtime;
    await page.clock.install({ time: new Date("2026-10-24T00:00:00Z") });
    await runtime.openPairedChat();
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("wait for steering");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("status", { name: "Agent is working" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop agent output" })).toBeEnabled();
    await page.context().setOffline(true);
    await expect(page.getByTestId(dataTestId.sessionReconnectNotice)).toContainText("No network connection");
    await composer.fill("Keep this follow-up");
    await expect(page.getByTestId(dataTestId.sendMessage)).toBeDisabled();
    await composer.press("Enter");
    await expect(composer).toHaveValue("Keep this follow-up");
    await expect(page.getByTestId(dataTestId.queuedMessage)).toHaveCount(0);
    await page.context().setOffline(false);
    await page.clock.runFor(5000);
    await expect(page.getByTestId(dataTestId.sessionReconnectNotice)).toBeHidden();
    await composer.press("Enter");
    await expect(page.getByTestId(dataTestId.queuedMessage)).toContainText("Keep this follow-up");
});
