import { createContext, type ReactNode, useContext } from "react";
export interface ApiTransport {
    readonly open: () => void;
    readonly fetch: (request: Request) => Promise<Response>;
    readonly measureRelayLatency: (signal: AbortSignal) => Promise<number>;
    readonly subscribe: (request: Request, receive: (data: string) => void) => Promise<void>;
    readonly waitForChange: (request: Request) => Promise<void>;
    readonly close: () => void;
}

const ApiTransportContext = createContext<ApiTransport | null>(null);

export function ApiTransportProvider({
    children,
    transport,
}: {
    readonly children: ReactNode;
    readonly transport: ApiTransport;
}) {
    return <ApiTransportContext.Provider value={transport}>{children}</ApiTransportContext.Provider>;
}

export function useApiTransport(): ApiTransport {
    const transport = useContext(ApiTransportContext);
    if (transport === null) {
        throw new Error("The Chat API transport is unavailable.");
    }
    return transport;
}
