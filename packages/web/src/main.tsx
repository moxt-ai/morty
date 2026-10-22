import "./monitoring.ts";
import { installMortyDebugBridge } from "./debug-bridge.ts";
import { WebSocketApiTransport } from "./services/api/websocket-api-transport.ts";
import { mountMorty } from "./views/bootstrap.tsx";
import "./styles.css";

installMortyDebugBridge();

const rootElement = document.getElementById("root");
if (rootElement === null) {
    throw new Error("Missing application root");
}

const morty = mountMorty({
    element: rootElement,
    origin: window.location.origin,
    transport: new WebSocketApiTransport(window.location.origin),
});

// The browser may hide the page into the back/forward cache instead of
// discarding it. Disposing there would strand a restored page with a closed
// transport, so only release the application when the page is truly going
// away; a restored page reloads itself below to rebuild live connections.
window.addEventListener("pagehide", (event) => {
    if (!event.persisted) {
        morty.dispose();
    }
});
window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
        window.location.reload();
    }
});
