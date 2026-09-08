import {
    createRootRoute,
    createRoute,
    createRouter,
    Outlet,
    redirect,
    useRouter,
    useRouterState,
} from "@tanstack/react-router";
import type { ComponentType } from "react";
import * as v from "valibot";
import { reportApplicationError } from "../../view-models/report-error.ts";
import type {
    BrowserWorkspaceConnections,
    WorkspaceChannel,
    WorkspaceConnectionProps,
} from "../../view-models/workspaces/connections.ts";
import { type WorkspaceDirectory, workspacePageSize } from "../../view-models/workspaces/contracts.ts";
import { loadWorkspace, loadWorkspaces, mutateWorkspace } from "../../view-models/workspaces/data.ts";
import { createWorkspaceStore } from "../../view-models/workspaces/store.ts";
import { WorkspaceDetail, WorkspaceFailure, WorkspaceList } from "./workspaces.tsx";

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
                <p role="status" className="mb-4 text-sm text-zinc-500">
                    Loading workspace…
                </p>
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

export function createWorkspaceRouter<TConnection extends WorkspaceChannel>(
    directory: WorkspaceDirectory,
    authorize: (signal: AbortSignal) => Promise<void>,
    WorkspaceManagement: ComponentType<WorkspaceConnectionProps<TConnection>>,
    connections: BrowserWorkspaceConnections<TConnection>,
) {
    const ui = createWorkspaceStore();
    const rootRoute = createRootRoute({
        beforeLoad: async ({ abortController }) => {
            await authorize(abortController.signal);
        },
        component: WorkspaceLayout,
        errorComponent: RouteFailure,
        notFoundComponent: () => <WorkspaceFailure message="Page not found." />,
    });
    const indexRoute = createRoute({
        getParentRoute: () => rootRoute,
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
    const detailRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: "/workspaces/$workspaceId",
        validateSearch: (search) => ({ channel: Reflect.get(search, "channel") }),
        loaderDeps: ({ search }) => ({ channel: search.channel }),
        loader: async ({ abortController, params, deps }) => {
            const workspace = await loadWorkspace(directory, params.workspaceId, abortController.signal);
            const connection = await connections.load(workspace.id, deps.channel, abortController.signal);
            return { workspace, connection };
        },
        component: function WorkspaceDetailRoute() {
            const { workspace, connection } = detailRoute.useLoaderData();
            return (
                <WorkspaceDetail workspace={workspace}>
                    <WorkspaceManagement
                        key={`${workspace.id}:${connection.kind === "connected" ? connection.connection.channelId : "unpaired"}`}
                        initialConnection={connection}
                        onConnected={(channel) => connections.save(workspace.id, channel)}
                    />
                </WorkspaceDetail>
            );
        },
    });
    return createRouter({
        routeTree: rootRoute.addChildren([indexRoute, detailRoute]),
        defaultOnCatch: (error) => reportApplicationError(error, "workspace-route"),
        scrollRestoration: true,
    });
}
