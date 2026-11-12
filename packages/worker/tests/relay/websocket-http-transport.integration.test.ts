import { SELF } from "cloudflare:test";
import { CONTENT_CHUNK_MAX_BYTES, encodeContentChunkFrame } from "@morty-build/client/protocol";
import { expect, it, vi } from "vitest";
import { acceptWebSocketHttpTransport } from "../../src/computer-relay/components/runtime/http/websocket-http-transport.ts";
import { SessionRuntimeError } from "../../src/contracts/relay/session.ts";
import type { WebSocketHttpOperation } from "../../src/contracts/websocket-http-dispatch.ts";
import { createOwner, issueSession, ownerOrigin, ownerRequest, pairComputer } from "./owner-fixture.ts";

class FailingDaemonBoundary {
    requests = 0;

    readonly fetch = (operation: WebSocketHttpOperation): Promise<Response> => {
        if (operation.kind === "upload-admission") {
            return Promise.resolve(new Response(null, { status: 204 }));
        }
        this.requests += 1;
        return Promise.reject(
            new SessionRuntimeError("agent_execution_failed", "The local Agent exited before completing the request"),
        );
    };
}

function nextMessage(socket: WebSocket): Promise<string> {
    return new Promise((resolve, reject) => {
        socket.addEventListener(
            "message",
            (event) => {
                if (typeof event.data !== "string") {
                    reject(new Error("Expected a text WebSocket message"));
                    return;
                }
                resolve(event.data);
            },
            { once: true },
        );
    });
}

it("Given a browser connection, When it requests a retired private Computer API, Then the transport rejects the target rather than routing it as a supported operation", async () => {
    const computerId = "prj_ap_01_000000000000000000000001";
    const response = await SELF.fetch(`https://relay.test/morty/api/v1/computers/${computerId}/transport`, {
        headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected the public WebSocket transport");
    }
    socket.accept();
    try {
        const answer = nextMessage(socket);
        socket.send(
            JSON.stringify({
                kind: "http.request",
                requestId: "retired-private-computer",
                method: "GET",
                path: `/morty/api/v1/computers/${computerId}/daemon/agents`,
                headers: [],
                body: "",
            }),
        );
        expect(JSON.parse(await answer)).toMatchObject({
            kind: "http.error",
            requestId: "retired-private-computer",
            code: "invalid_target",
            status: 400,
        });
    } finally {
        socket.close(1000, "Test complete");
    }
});

it.each([
    { operation: "unknown-command", kind: "http.response", status: 404, code: "not_found" },
    { operation: "access-credentials", kind: "http.error", status: 400, code: "invalid_target" },
    { operation: "access-credentials/unknown-command", kind: "http.error", status: 400, code: "invalid_target" },
])(
    "Given a browser connection, When it requests Session operation $operation, Then the owning route preserves its existing $status rejection",
    async ({ operation, kind, status, code }) => {
        const computerId = "prj_ap_01_000000000000000000000001";
        const response = await SELF.fetch(`https://relay.test/morty/api/v1/computers/${computerId}/transport`, {
            headers: { Upgrade: "websocket" },
        });
        const socket = response.webSocket;
        if (socket === null) {
            throw new Error("Expected the public WebSocket transport");
        }
        socket.accept();
        try {
            const answer = nextMessage(socket);
            socket.send(
                JSON.stringify({
                    kind: "http.request",
                    requestId: "unsupported-session-operation",
                    method: "GET",
                    path: `/morty/api/v1/computers/${computerId}/harnesses/codex/sessions/example/${operation}`,
                    headers: [["authorization", "Bearer untrusted-credential"]],
                    body: "",
                }),
            );
            const frame = JSON.parse(await answer);
            expect(frame).toMatchObject({ kind, status, requestId: "unsupported-session-operation" });
            if (kind === "http.response") {
                expect(JSON.parse(frame.body)).toMatchObject({ error: { code } });
            } else {
                expect(frame).toMatchObject({ code });
            }
        } finally {
            socket.close();
        }
    },
);

it("Given a browser connection, When it heartbeats through the public Relay transport, Then the Computer acknowledges it and an unauthenticated Session request is rejected", async () => {
    const response = await SELF.fetch(
        "https://relay.test/morty/api/v1/computers/prj_ap_01_000000000000000000000001/transport",
        {
            headers: { Upgrade: "websocket" },
        },
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected the public WebSocket transport");
    }
    socket.accept();
    try {
        const heartbeat = nextMessage(socket);
        socket.send('{"kind":"ping"}');
        expect(await heartbeat).toBe('{"kind":"pong"}');
        const result = nextMessage(socket);
        socket.send(
            JSON.stringify({
                kind: "http.request",
                requestId: "after-heartbeat",
                method: "GET",
                path: "/morty/api/v1/computers/prj_ap_01_000000000000000000000001/harnesses/codex/sessions/example/active-turn",
                headers: [],
                body: "",
            }),
        );
        expect(JSON.parse(await result)).toMatchObject({
            kind: "http.error",
            requestId: "after-heartbeat",
            status: 400,
            code: "invalid_target",
        });
    } finally {
        socket.close();
    }
});

it.each([
    {
        path: "/morty/api/v1/computers/prj_ap_01_000000000000000000000002/harnesses/codex/sessions/example/active-turn",
        binary: false,
    },
    { path: "/morty/api/computers/prj_ap_01_000000000000000000000002/session", binary: false },
    { path: "/morty/api/chat/computers/prj_ap_01_000000000000000000000002/agent-settings", binary: false },
    {
        path: `/morty/api/v1/computers/prj_ap_01_000000000000000000000002/harnesses/codex/sessions/example/content/${"a".repeat(64)}`,
        binary: true,
    },
])(
    "Given a Computer-bound browser, When it addresses another computer at $path (binary: $binary), Then the request is rejected without closing the browser connection",
    async ({ path, binary }) => {
        const response = await SELF.fetch(
            "https://relay.test/morty/api/v1/computers/prj_ap_01_000000000000000000000001/transport",
            {
                headers: { Upgrade: "websocket" },
            },
        );
        expect(response.status).toBe(101);
        const socket = response.webSocket;
        if (socket === null) {
            throw new Error("Expected the public WebSocket transport");
        }
        socket.accept();
        try {
            const result = nextMessage(socket);
            socket.send(
                JSON.stringify({
                    kind: "http.request",
                    requestId: "request-identity",
                    method: binary ? "PUT" : "GET",
                    path,
                    headers: [["authorization", "Bearer untrusted-credential"]],
                    body: "",
                    ...(binary ? { bodyByteLength: 1 } : {}),
                }),
            );
            expect(JSON.parse(await result)).toMatchObject({
                kind: "http.error",
                code: "invalid_target",
                requestId: "request-identity",
                status: 400,
            });
            const heartbeat = nextMessage(socket);
            socket.send('{"kind":"ping"}');
            expect(await heartbeat).toBe('{"kind":"pong"}');
        } finally {
            socket.close();
        }
    },
);

it("Given two browser connections to one Computer, When their pending uploads exceed its shared budget, Then the second upload is refused and capacity is released after a failed transfer", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2030-01-01T00:00:00Z") });
    const sockets: WebSocket[] = [];
