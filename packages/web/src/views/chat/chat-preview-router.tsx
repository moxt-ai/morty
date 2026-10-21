import { createRootRoute, createRoute, createRouter, Link, Outlet, useParams } from "@tanstack/react-router";
import { reportApplicationError } from "../../index.ts";
import { setupPageClassName, setupSectionClassName } from "../setup/setup-card-shell.tsx";
import { CHAT_PREVIEW_STATE_LABELS, CHAT_PREVIEW_STATES, isChatPreviewStateId } from "./chat-preview.ts";
import { ChatPreviewPageContent } from "./chat-preview-page.tsx";

function ChatPreviewIndexPage() {
    return (
        <main className={setupPageClassName}>
            <section aria-labelledby="chat-preview-index-title" className={`${setupSectionClassName} md:max-w-[640px]`}>
                <h1 id="chat-preview-index-title" className="text-24 font-semibold tracking-[-0.03em]">
                    Chat UI preview
                </h1>
                <p className="mt-2 text-14 leading-[22px] text-muted-foreground">
                    Temporary route for adjusting Chat layout and styles without a local Agent. Removed before shipping.
                </p>
                <Link
                    className="mt-5 block rounded-xl border border-primary/25 bg-primary/5 px-4 py-4 text-14 transition-colors hover:bg-primary/10"
                    to="/chat/preview/$stateId"
                    params={{ stateId: "interactive" }}
                >
                    <span className="font-semibold text-primary">Open the interactive playground</span>
                    <span className="mt-1 block text-muted-foreground">
                        Connecting, switching sessions, sending messages, and dialogs all use local mock data.
                    </span>
                </Link>
                <ul className="mt-6 grid gap-2">
                    {CHAT_PREVIEW_STATES.map((id) => (
                        <li key={id}>
                            <Link
                                className="block rounded-lg border border-border/60 bg-card px-4 py-3 text-14 transition-colors hover:bg-muted/40"
                                to="/chat/preview/$stateId"
                                params={{ stateId: id }}
                            >
                                <span className="font-medium">{CHAT_PREVIEW_STATE_LABELS[id]}</span>
                                <span className="mt-0.5 block font-mono text-xs text-muted-foreground">
                                    /chat/preview/{id}
                                </span>
                            </Link>
                        </li>
                    ))}
                </ul>
            </section>
        </main>
    );
}

function ChatPreviewStatePage() {
    const { stateId } = useParams({ from: "/chat/preview/$stateId" });
    if (!isChatPreviewStateId(stateId)) {
        return (
            <main className={setupPageClassName}>
                <section className={setupSectionClassName}>
                    <p role="alert" className="text-destructive">
                        Unknown preview state: {stateId}
                    </p>
                    <Link className="mt-4 inline-block text-primary underline underline-offset-4" to="/chat/preview">
                        Back to the preview list
                    </Link>
                </section>
            </main>
        );
    }
    return <ChatPreviewPageContent previewId={stateId} />;
}

const rootRoute = createRootRoute({ component: Outlet });
const chatPreviewIndexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/chat/preview",
    component: ChatPreviewIndexPage,
});
const chatPreviewStateRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/chat/preview/$stateId",
    component: ChatPreviewStatePage,
});

export const chatPreviewRouter = createRouter({
    routeTree: rootRoute.addChildren([chatPreviewIndexRoute, chatPreviewStateRoute]),
    defaultOnCatch: (error) => reportApplicationError(error, "chat-preview-route"),
    scrollRestoration: true,
});
