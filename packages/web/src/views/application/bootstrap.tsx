import { useEffect, useState } from "react";
import { ApiTransportProvider } from "../../services/api/api-transport-context.tsx";
import { WebSocketApiTransport } from "../../services/api/websocket-api-transport.ts";
import { SessionApplication } from "../authentication/session-application.tsx";

export function Bootstrap() {
    const [transport] = useState(() => new WebSocketApiTransport(window.location.origin));
    useEffect(() => {
        transport.open();
        return () => transport.close();
    }, [transport]);
    return (
        <ApiTransportProvider transport={transport}>
            <SessionApplication />
        </ApiTransportProvider>
    );
}
