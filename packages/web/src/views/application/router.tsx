import { isIdentifier } from "@moxt-ai/mobius-sdk/protocol";
import { createRootRoute, createRoute, createRouter, Outlet, useRouter } from "@tanstack/react-router";
import type { ComponentType, ReactNode } from "react";
import { Button } from "../../components/ui/cloud-button.tsx";
import { describePageFailure } from "../../view-models/format-error.ts";
import { reportApplicationError } from "../../view-models/report-error.ts";
import {
    SetupCardDescription,
    SetupCardFailureIcon,
    SetupCardSection,
    SetupCardShell,
    SetupCardTitle,
    setupPrimaryButtonClassName,
    setupPrimaryButtonSize,
} from "../setup/setup-card-shell.tsx";

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

export function RouteFailureContent({ error, onRetry }: { readonly error: Error; readonly onRetry: () => void }) {
    const details = getRouteFailureDetails(error);
    const copy = describePageFailure(details.message, "Something went wrong");
    return (
        <SetupCardShell
            cardClassName="pb-10"
            cardLeading={<SetupCardFailureIcon />}
            showPageHeader
            titleId="route-failure-title"
        >
            <div className="min-w-0" role="alert">
                <SetupCardTitle className="[overflow-wrap:anywhere]" id="route-failure-title">
                    {copy.title}
                </SetupCardTitle>
                <SetupCardDescription className="[overflow-wrap:anywhere]">{copy.content}</SetupCardDescription>
            </div>
            {details.kind === "message-with-url" && (
                <div className="mt-4 w-full min-w-0 overflow-hidden rounded-[16px] bg-muted/50">
                    <code className="block select-text px-4 py-3 text-center text-xs leading-5 text-morty-text-2 [overflow-wrap:anywhere]">
                        {details.url}
                    </code>
                </div>
            )}
            <SetupCardSection className="mt-4">
                <Button className={setupPrimaryButtonClassName} onClick={onRetry} size={setupPrimaryButtonSize}>
                    Try again
                </Button>
            </SetupCardSection>
        </SetupCardShell>
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
