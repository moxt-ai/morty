import "./monitoring.ts";
import { WorkerApiTransport } from "./services/api/worker-api-transport.ts";
import { mountMorty } from "./views/bootstrap.tsx";
import "./styles.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
    throw new Error("Missing application root");
}

const morty = mountMorty({
    element: rootElement,
    origin: window.location.origin,
    transport: new WorkerApiTransport(window.location.origin),
});

// The browser may hide the page into the back/forward cache instead of
// discarding it. Disposing there would strand a restored page with a closed
// transport, so only release the application when the page is truly going
// away; the application probes its connections when the browser restores it.
window.addEventListener("pagehide", (event) => {
    if (!event.persisted) {
        morty.dispose();
    }
});
