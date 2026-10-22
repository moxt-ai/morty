import { createRootRoute, createRoute, createRouter, Link, Outlet, useParams } from "@tanstack/react-router";
import { reportApplicationError } from "../../index.ts";
import type { ContinueStoreApi } from "../../view-models/authentication/continue-store.ts";
import { useExternalStore } from "../../view-models/external-store.ts";
import type { MortyApplication } from "../../view-models/morty-application.ts";
import { useMortyApplication } from "../application/application-context.tsx";
import { BugReportButton } from "../diagnostics/bug-report-button.tsx";
import { setupPageClassName, setupSectionClassName } from "../setup/setup-card-shell.tsx";
import { ContinuePageContent } from "./continue-page-content.tsx";
import {
    CONTINUE_PREVIEW_STATE_LABELS,
    CONTINUE_PREVIEW_STATES,
    type ContinuePreviewStateId,
    continuePreviewState,
    getContinuePreviewStateId,
    isContinuePreviewStateId,
} from "./continue-preview.ts";

function ContinuePagePreview({ previewId }: { readonly previewId: ContinuePreviewStateId }) {
    const state = continuePreviewState(previewId);
    return <ContinuePageContent enterMorty={() => {}} retry={() => {}} state={state} />;
}

function ContinuePageLive({
    application,
    continuation,
}: {
    readonly application: MortyApplication;
    readonly continuation: ContinueStoreApi;
}) {
    // The application creates the redeem with itself; the page only
    // subscribes.
    const { retry, enterMorty, state, diagnostics, continueHref } = useExternalStore(continuation);
    return (
        <>
            <ContinuePageContent continueHref={continueHref} enterMorty={enterMorty} retry={retry} state={state} />
            <BugReportButton appearance="floating" daemonSource={diagnostics} dialog={application.bugReportDialog} />
        </>
    );
}

function ContinuePage() {
    // TEMP style-tuning preview: `?continuePreview=<state>` on /continue forces one UI state. Remove with continue-preview.ts.
    const application = useMortyApplication();
    const previewId = getContinuePreviewStateId(new URLSearchParams(window.location.search));
    if (previewId !== null) {
        return <ContinuePagePreview previewId={previewId} />;
    }
    return <ContinuePageLive application={application} continuation={application.continuation} />;
}

function ContinuePreviewIndexPage() {
    return (
        <main className={setupPageClassName}>
            <section
                aria-labelledby="continue-preview-index-title"
                className={`${setupSectionClassName} md:max-w-[640px]`}
            >
                <h1 id="continue-preview-index-title" className="text-24 font-semibold tracking-[-0.03em]">
                    Continue link page preview
                </h1>
                <p className="mt-2 text-14 leading-[22px] text-muted-foreground">
                    Temporary routes for tuning Agent handoff / continue UI. Remove before shipping.
                </p>
                <ul className="mt-6 grid gap-2">
                    {CONTINUE_PREVIEW_STATES.map((id) => (
                        <li key={id}>
                            <Link
                                className="block rounded-lg border border-border/60 bg-card px-4 py-3 text-14 transition-colors hover:bg-muted/40"
                                to="/continue/preview/$stateId"
                                params={{ stateId: id }}
                            >
                                <span className="font-medium">{CONTINUE_PREVIEW_STATE_LABELS[id]}</span>
                                <span className="mt-0.5 block font-mono text-xs text-muted-foreground">
                                    /continue/preview/{id}
                                </span>
                            </Link>
                        </li>
                    ))}
                </ul>
            </section>
        </main>
    );
}

function ContinuePreviewStatePage() {
    const { stateId } = useParams({ from: "/continue/preview/$stateId" });
    if (!isContinuePreviewStateId(stateId)) {
        return (
            <main className={setupPageClassName}>
                <section className={setupSectionClassName}>
                    <p role="alert" className="text-destructive">
                        Unknown preview state: {stateId}
                    </p>
                    <Link
                        className="mt-4 inline-block text-primary underline underline-offset-4"
                        to="/continue/preview"
                    >
                        Back to preview index
                    </Link>
                </section>
            </main>
        );
    }
    const state = continuePreviewState(stateId);
    return <ContinuePageContent enterMorty={() => {}} retry={() => {}} state={state} />;
}

const rootRoute = createRootRoute({ component: Outlet });
const continueRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/continue",
    component: ContinuePage,
});
const continuePreviewIndexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/continue/preview",
    component: ContinuePreviewIndexPage,
});
const continuePreviewStateRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/continue/preview/$stateId",
    component: ContinuePreviewStatePage,
});

export const createContinuationRouter = () =>
    createRouter({
        routeTree: rootRoute.addChildren([continueRoute, continuePreviewIndexRoute, continuePreviewStateRoute]),
        defaultOnCatch: (error) => reportApplicationError(error, "continuation-route"),
        scrollRestoration: true,
    });
