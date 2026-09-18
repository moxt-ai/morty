import { createContext, type ReactNode, useContext } from "react";
import type { WebSocketApiTransport } from "./websocket-api-transport.ts";

const ApiTransportContext = createContext<WebSocketApiTransport | null>(null);

export function ApiTransportProvider({
    children,
    transport,
}: {
    readonly children: ReactNode;
    readonly transport: WebSocketApiTransport;
}) {
    return <ApiTransportContext.Provider value={transport}>{children}</ApiTransportContext.Provider>;
}

export function useApiTransport(): WebSocketApiTransport {
    const transport = useContext(ApiTransportContext);
    if (transport === null) {
        throw new Error("The Chat API transport is unavailable.");
    }
    return transport;
}
