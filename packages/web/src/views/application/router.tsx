import { isIdentifier } from "@moxt-ai/mobius-protocol";
import { createRootRoute, createRoute, createRouter, Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import type { ComponentType, ReactNode } from "react";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
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

export function createApplicationRouter(
    authorize: (signal: AbortSignal) => Promise<void>,
    Content: ComponentType<{ readonly view: "overview" | "chat" }>,
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
    function page(path: "/" | "/chat", view: "overview" | "chat") {
        const route = createRoute({
            getParentRoute: () => root,
            path,
            validateSearch: (search) => {
                const sessionId = Reflect.get(search, "sessionId");
                return {
                    sessionId: isIdentifier(sessionId) ? sessionId : undefined,
                };
            },
            component: function ApplicationRoute() {
                const body = <Content view={view} />;
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
        routeTree: root.addChildren([page("/", "overview"), page("/chat", "chat")]),
        defaultOnCatch: (error) => reportApplicationError(error, "application-route"),
        scrollRestoration: true,
    });
}
