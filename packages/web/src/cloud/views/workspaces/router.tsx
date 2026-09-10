import {
    createRootRoute,
    createRoute,
    createRouter,
    Outlet,
    redirect,
    useRouter,
    useRouterState,
} from "@tanstack/react-router";
import type { ComponentType, ReactNode } from "react";
import * as v from "valibot";
import { Spinner } from "../../components/ui/spinner.tsx";
import { reportApplicationError } from "../../view-models/report-error.ts";
import type {
    BrowserWorkspaceConnections,
    WorkspaceChannel,
    WorkspaceConnection,
    WorkspaceConnectionProps,
} from "../../view-models/workspaces/connections.ts";
import { type WorkspaceDirectory, workspacePageSize } from "../../view-models/workspaces/contracts.ts";
import { loadWorkspace, loadWorkspaces, mutateWorkspace } from "../../view-models/workspaces/data.ts";
import { createWorkspaceStore } from "../../view-models/workspaces/store.ts";
import {
    AllWorkspacesLink,
    WorkspaceApplicationView,
    WorkspaceDetail,
    WorkspaceFailure,
    WorkspaceList,
} from "./workspaces.tsx";

const pageSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100_000));

function parsePage(value: unknown): number {
    const candidate = typeof value === "string" ? Number(value) : value;
    const parsed = v.safeParse(pageSchema, candidate);
    return parsed.success ? parsed.output : 1;
}

function WorkspaceLayout() {
    const loading = useRouterState({
        select: (state) => state.status === "pending",
    });
    return (
        <>
            {loading && (
                <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex size-10 items-center justify-center rounded-lg border border-border bg-card">
                    <Spinner label="Loading workspace" />
                </div>
            )}
            <Outlet />
        </>
    );
}

function RouteFailure({ error, reset }: { readonly error: Error; readonly reset: () => void }) {
    const router = useRouter();
    return (
        <WorkspaceFailure
            cause={error}
            refresh={() => {
                reset();
                void router.invalidate();
            }}
        />
    );
}

export interface WorkspaceShellProps {
    readonly children: ReactNode;
    readonly navigation?: ReactNode;
}

export function createWorkspaceRouter<TConnection extends WorkspaceChannel>(
    directory: WorkspaceDirectory,
    authorize: (signal: AbortSignal) => Promise<void>,
    WorkspaceManagement: ComponentType<WorkspaceConnectionProps<TConnection>>,
    connections: BrowserWorkspaceConnections<TConnection>,
    layouts: {
        readonly Standard: ComponentType<WorkspaceShellProps>;
        readonly Application: ComponentType<WorkspaceShellProps>;
    },
) {
    const { Standard, Application } = layouts;
    const ui = createWorkspaceStore();
    const rootRoute = createRootRoute({
        beforeLoad: async ({ abortController }) => {
            await authorize(abortController.signal);
        },
        component: Outlet,
        errorComponent: (props) => (
            <Standard>
                <RouteFailure {...props} />
            </Standard>
        ),
        notFoundComponent: () => (
            <Standard>
                <WorkspaceFailure message="Page not found." />
            </Standard>
        ),
    });
    const standardLayout = createRoute({
        getParentRoute: () => rootRoute,
        id: "standard",
        component: () => (
            <Standard>
                <WorkspaceLayout />
            </Standard>
        ),
    });
    const applicationLayout = createRoute({
        getParentRoute: () => rootRoute,
        id: "application",
        component: () => (
            <Application navigation={<AllWorkspacesLink />}>
                <WorkspaceLayout />
            </Application>
        ),
    });
    const detailLayout = createRoute({
        getParentRoute: () => rootRoute,
        id: "workspace",
        component: () => (
            <Standard navigation={<AllWorkspacesLink />}>
                <WorkspaceLayout />
            </Standard>
        ),
    });
    const indexRoute = createRoute({
        getParentRoute: () => standardLayout,
        path: "/",
        validateSearch: (search) => ({
            page: parsePage(Reflect.get(search, "page")),
        }),
        loaderDeps: ({ search }) => ({ page: search.page }),
        loader: async ({ abortController, deps }) => {
            const result = await loadWorkspaces(directory, deps.page, abortController.signal);
            if (result.page > 1 && result.items.length === 0) {
                throw redirect({
                    to: "/",
                    search: {
                        page: Math.max(1, Math.ceil(result.totalCount / workspacePageSize)),
                    },
                    replace: true,
                });
            }
            return result;
        },
        component: function WorkspaceIndexRoute() {
            const router = useRouter();
            return (
                <WorkspaceList
                    data={indexRoute.useLoaderData()}
                    ui={ui}
                    refresh={async () => {
                        await router.invalidate();
                    }}
                    mutate={async (form, signal) => {
                        const result = await mutateWorkspace(directory, ui, form, signal);
                        if (result.kind === "success") {
                            await router.invalidate();
                        }
                        return result;
                    }}
                />
            );
        },
    });
    function workspacePage(
        path: "/workspaces/$workspaceId" | "/workspaces/$workspaceId/chat" | "/workspaces/$workspaceId/slack",
        view: "overview" | "chat" | "slack",
        parent: typeof detailLayout | typeof applicationLayout,
    ) {
        const detailRoute = createRoute({
            getParentRoute: () => parent,
            path,
            validateSearch: (search) => ({ channel: Reflect.get(search, "channel") }),
            loaderDeps: ({ search }) => ({ channel: search.channel }),
            loader: async ({ abortController, params, deps }) => {
                const workspace = await loadWorkspace(directory, params.workspaceId, abortController.signal);
                const connection: WorkspaceConnection<TConnection> =
                    view === "chat" || deps.channel !== undefined
                        ? await connections.load(workspace.id, deps.channel, abortController.signal)
                        : { kind: "unpaired" };
                return { workspace, connection };
            },
            component: function WorkspaceDetailRoute() {
                const { workspace, connection } = detailRoute.useLoaderData();
                const content = (
                    <WorkspaceManagement
                        view={view}
                        workspacePath={`/workspaces/${workspace.id}`}
                        key={`${workspace.id}:${connection.kind === "connected" ? connection.connection.channelId : "unpaired"}`}
                        initialConnection={connection}
                    />
                );
                return view === "overview" ? (
                    <WorkspaceDetail workspace={workspace}>{content}</WorkspaceDetail>
                ) : (
                    <WorkspaceApplicationView>{content}</WorkspaceApplicationView>
                );
            },
        });
        return detailRoute;
    }
    return createRouter({
        routeTree: rootRoute.addChildren([
            standardLayout.addChildren([indexRoute]),
            detailLayout.addChildren([workspacePage("/workspaces/$workspaceId", "overview", detailLayout)]),
            applicationLayout.addChildren([
                workspacePage("/workspaces/$workspaceId/chat", "chat", applicationLayout),
                workspacePage("/workspaces/$workspaceId/slack", "slack", applicationLayout),
            ]),
        ]),
        defaultOnCatch: (error) => reportApplicationError(error, "workspace-route"),
        scrollRestoration: true,
    });
}
