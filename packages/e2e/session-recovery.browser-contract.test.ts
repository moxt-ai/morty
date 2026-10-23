import { createServer, request } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { WebSocket } from "playwright-core";
import { test as base, expect } from "./infra/test.ts";

type Network = {
    readonly url: string;
    readonly blackhole: (route: "all" | "session" | "bridge") => void;
    readonly disconnect: () => void;
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
        await expect(composer).toBeDisabled();
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
        await page.clock.runFor(5000);
        if (route !== "bridge") {
            await expect(composer).toBeDisabled();
        }
        await page.clock.runFor(5000);
        await expect(composer).toBeEnabled();
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
    const connected = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    await page.goto(connected.url);
    const composer = page.getByRole("textbox", { name: "Message" });
    await expect(composer).toBeEnabled();
    await composer.fill("Establish the conversation before the network stalls.");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("article", { name: "Agent response" }).last()).toContainText(
        "Establish the conversation before the network stalls.",
    );
    network.blackhole("session");
    await page.clock.runFor(25000);
    await page.clock.runFor(5000);
    await expect(composer).toBeDisabled();
    await page.clock.runFor(5000);
    await expect(composer).toBeEnabled();
    await composer.fill("Send after silent network recovery.");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("article", { name: "Agent response" }).last()).toContainText(
        "Send after silent network recovery.",
    );
});
