import { isIdentifier } from "@moxt-ai/mobius-protocol";
import { createRootRoute, createRoute, createRouter, Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import type { ComponentType, ReactNode } from "react";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import type {
    ApplicationConnectionProps,
    BrowserChannelConnection,
    ChannelReference,
    SavedChannel,
} from "../../view-models/channel-connection.ts";
import { reportApplicationError } from "../../view-models/report-error.ts";

export interface ApplicationShellProps {
    readonly children: ReactNode;
}

function LoadingIndicator() {
    const loading = useRouterState({ select: (state) => state.status === "pending" });
    return (
        <>
            {loading && (
                <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex size-10 items-center justify-center rounded-lg border border-border bg-card">
                    <Spinner label="Loading application" />
                </div>
            )}
            <Outlet />
        </>
    );
}

function RouteFailure({ error, reset }: { readonly error: Error; readonly reset: () => void }) {
    const router = useRouter();
    return (
        <section className="grid gap-4" role="alert">
            <p>{error.message || "The application could not be loaded."}</p>
            <Button
                onClick={() => {
                    reset();
                    void router.invalidate();
                }}
            >
                Try again
            </Button>
        </section>
    );
}

export function createApplicationRouter<TConnection extends ChannelReference>(
    authorize: (signal: AbortSignal) => Promise<void>,
    userId: string,
    Content: ComponentType<ApplicationConnectionProps<TConnection>>,
    connection: BrowserChannelConnection<TConnection>,
    layouts: {
        readonly Standard: ComponentType<ApplicationShellProps>;
        readonly Application: ComponentType<ApplicationShellProps>;
    },
) {
    const root = createRootRoute({
        beforeLoad: async ({ abortController }) => await authorize(abortController.signal),
        component: LoadingIndicator,
        errorComponent: (props) => (
            <layouts.Standard>
                <RouteFailure {...props} />
            </layouts.Standard>
        ),
    });
    function page(path: "/" | "/chat" | "/slack", view: ApplicationConnectionProps<TConnection>["view"]) {
        const route = createRoute({
            getParentRoute: () => root,
            path,
            validateSearch: (search) => {
                const sessionId = Reflect.get(search, "sessionId");
                return {
                    channel: Reflect.get(search, "channel"),
                    sessionId: view !== "slack" && isIdentifier(sessionId) ? sessionId : undefined,
                };
            },
            loaderDeps: ({ search }) => ({ channel: search.channel }),
            loader: async ({ abortController, deps }) => {
                const saved: SavedChannel<TConnection> =
                    view === "chat" || deps.channel !== undefined
                        ? await connection.load(deps.channel, abortController.signal)
                        : { kind: "unpaired" };
                return saved;
            },
            component: function ApplicationRoute() {
                const saved = route.useLoaderData();
                const body = <Content userId={userId} view={view} initialConnection={saved} />;
                return view === "overview" ? (
                    <layouts.Standard>{body}</layouts.Standard>
                ) : (
                    <layouts.Application>{body}</layouts.Application>
                );
            },
        });
        return route;
    }
    return createRouter({
        routeTree: root.addChildren([page("/", "overview"), page("/chat", "chat"), page("/slack", "slack")]),
        defaultOnCatch: (error) => reportApplicationError(error, "application-route"),
        scrollRestoration: true,
    });
}
