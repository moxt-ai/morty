import type { WebSocketHttpDispatch } from "./websocket-http-dispatch.ts";

export interface ComputerApplication {
    readonly http: (request: Request) => Promise<Response>;
    readonly browser: (computerId: string) => WebSocketHttpDispatch;
}
