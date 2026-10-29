import { DurableObject } from "cloudflare:workers";
import application from "../../application.ts";
import { createApplicationDependencies } from "../../composition/application-context.ts";
import { createCloudWebSocketHandlers } from "../../composition/cloud-websocket.ts";
import { recordSetupFunnelStep } from "../../composition/setup-funnel.ts";
import type { CloudBindings } from "../../infra/cloud-bindings.ts";
import { json } from "../../infra/http.ts";
import { toHttpError } from "../../infra/http-error.ts";
import { RequestError } from "../../infra/request-error.ts";
import { createWebSocketApiBridge } from "../../infra/websocket-api-bridge.ts";

export class ChatWebSocketDurableObject extends DurableObject<CloudBindings> {
    #connection:
        | { readonly kind: "waiting" }
        | {
              readonly kind: "connected";
              readonly socket: WebSocket;
              readonly receive: (event: { readonly data: string | ArrayBuffer }) => void;
              readonly release: () => void;
          }
        | { readonly kind: "finished" } = { kind: "waiting" };

    constructor(state: DurableObjectState, environment: CloudBindings) {
        super(state, environment);
        state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"kind":"ping"}', '{"kind":"pong"}'));
        // Watches and in-flight requests are connection-owned. The bridge's idle timer keeps
        // their owner resident; after an unexpected restart, reconnect rather than lose them silently.
        for (const socket of state.getWebSockets()) {
            socket.close(1012, "Chat bridge restarted");
        }
    }

    override async fetch(request: Request): Promise<Response> {
        const logger = createApplicationDependencies(this.env).logger;
        try {
            return createWebSocketApiBridge(
                request,
                createCloudWebSocketHandlers({
                    dispatch: async (dispatched) => {
                        const response = await application.fetch(dispatched, this.env);
                        // Only the browser application talks to Morty over this bridge.
                        recordSetupFunnelStep(logger, dispatched, response, "browser");
                        return response;
                    },
                    logger,
                }),
                logger,
                {
                    accept: (socket, receive, release) => {
                        if (this.#connection.kind !== "waiting") {
                            throw new RequestError(
                                "BRIDGE_ALREADY_CONNECTED",
                                "The Chat bridge is already connected.",
                                409,
                            );
                        }
                        this.ctx.acceptWebSocket(socket);
                        this.#connection = { kind: "connected", socket, receive, release };
                    },
                    lastHeartbeatAt: (socket) => this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? null,
                },
            );
        } catch (error) {
            logger.error({ err: error }, "Chat WebSocket handshake failed");
            const response = toHttpError(error);
            return json(response.body, response.status, response.headers);
        }
    }

    override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
        if (this.#connection.kind === "connected" && this.#connection.socket === socket) {
            this.#connection.receive({ data: message });
        }
    }

    override webSocketClose(socket: WebSocket): void {
        this.#dispose(socket);
    }

    override webSocketError(socket: WebSocket): void {
        socket.close(1011, "Chat bridge failed");
        this.#dispose(socket);
    }

    readonly #dispose = (socket: WebSocket): void => {
        const connection = this.#connection;
        if (connection.kind === "connected" && connection.socket === socket) {
            this.#connection = { kind: "finished" };
            connection.release();
        }
    };
}
