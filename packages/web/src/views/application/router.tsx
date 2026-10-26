import { isIdentifier } from "@moxt-ai/mobius-sdk/protocol";
import { createRootRoute, createRoute, createRouter, Outlet, useRouter } from "@tanstack/react-router";
import { CircleAlert } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { Button } from "../../components/ui/cloud-button.tsx";
import { describePageFailure } from "../../view-models/format-error.ts";
import { reportApplicationError } from "../../view-models/report-error.ts";

export interface ApplicationShellProps {
    readonly children: ReactNode;
}

function RootRoute() {
    return <Outlet />;
}

type RouteFailureDetails =
    | { readonly kind: "message"; readonly message: string }
    | { readonly kind: "message-with-url"; readonly message: string; readonly url: string };

function getRouteFailureDetails(error: Error): RouteFailureDetails {
    const message = error.message.trim() || "The application could not be loaded.";
    const separatorIndex = message.lastIndexOf(": ");
    if (separatorIndex < 0) {
        return { kind: "message", message };
    }
    const candidate = message.slice(separatorIndex + 2);
    try {
        const url = new URL(candidate);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return { kind: "message", message };
        }
    } catch {
        return { kind: "message", message };
    }
    return {
        kind: "message-with-url",
        message: message.slice(0, separatorIndex),
        url: candidate,
    };
}

function RouteFailureContent({ error, onRetry }: { readonly error: Error; readonly onRetry: () => void }) {
    const details = getRouteFailureDetails(error);
    const copy = describePageFailure(details.message, "Something went wrong");
    return (
        <div className="grid min-h-dvh place-items-center p-4">
            <section className="grid w-full min-w-0 max-w-[460px] gap-4" role="alert">
                <div className="grid min-w-0 justify-items-center gap-3 text-center">
                    <span className="flex size-12 items-center justify-center rounded-full bg-destructive/5">
                        <CircleAlert aria-hidden="true" className="size-6 shrink-0 text-destructive" />
                    </span>
                    <div className="grid min-w-0 gap-2">
                        <h1 className="text-[18px] leading-6 font-semibold tracking-[-0.025em] [overflow-wrap:anywhere]">
                            {copy.title}
                        </h1>
                        <p className="text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">
                            {copy.content}
                        </p>
                        {details.kind === "message-with-url" && (
                            <div className="overflow-hidden rounded-[16px] bg-muted">
                                <code className="block select-text bg-background p-3 text-left text-[13px] leading-5 text-foreground [overflow-wrap:anywhere]">
                                    {details.url}
                                </code>
                            </div>
                        )}
                    </div>
                </div>
                <Button className="h-10 w-full" onClick={onRetry}>
                    Try again
                </Button>
            </section>
        </div>
    );
}

function RouteFailure({ error, reset }: { readonly error: Error; readonly reset: () => void }) {
    const router = useRouter();
    return (
        <RouteFailureContent
            error={error}
            onRetry={() => {
                reset();
                void router.invalidate();
            }}
        />
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
        component: RootRoute,
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
