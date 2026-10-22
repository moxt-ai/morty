import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import type { MortyApplication } from "../../view-models/morty-application.ts";
import { reportApplicationError } from "../../view-models/report-error.ts";
import { App } from "../application/app.tsx";
import { PlaygroundEntryPage, PlaygroundHome, PlaygroundShell } from "./playground-shell.tsx";

function createPlaygroundRouter() {
    const root = createRootRoute({ component: PlaygroundShell });
    const home = createRoute({
        component: PlaygroundHome,
        getParentRoute: () => root,
        path: "/playground",
    });
    const entry = createRoute({
        component: PlaygroundEntryPage,
        getParentRoute: () => root,
        path: "/playground/$entryId",
    });
    return createRouter({
        defaultOnCatch: (error) => reportApplicationError(error, "playground-route"),
        routeTree: root.addChildren([home, entry]),
        scrollRestoration: true,
    });
}

const playgroundRouter = createPlaygroundRouter();

export function PlaygroundApplication({ application }: { readonly application: MortyApplication }) {
    return (
        <App
            bugReportDialog={application.bugReportDialog}
            state={{ kind: "authentication", router: playgroundRouter }}
        />
    );
}
