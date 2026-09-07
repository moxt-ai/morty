import type { ComponentType } from "react";
import { createBrowserRouter, Outlet, useNavigation } from "react-router";
import type { WorkspaceDirectory } from "./contracts.ts";
import { loadWorkspace, loadWorkspaces, mutateWorkspace } from "./data.ts";
import { createWorkspaceStore } from "./store.ts";
import {
  WorkspaceDetail,
  WorkspaceFailure,
  WorkspaceList,
} from "./Workspaces.tsx";

function WorkspaceLayout() {
  const navigation = useNavigation();
  return (
    <>
      {navigation.state !== "idle" && (
        <p role="status" className="mb-4 text-sm text-zinc-500">
          Loading workspace…
        </p>
      )}
      <Outlet />
    </>
  );
}

export function createWorkspaceRouter(
  directory: WorkspaceDirectory,
  authorize: (signal: AbortSignal) => Promise<void>,
  WorkspaceManagement: ComponentType,
) {
  const ui = createWorkspaceStore();
  const router = createBrowserRouter([
    {
      path: "/",
      loader: async ({ request }) => {
        await authorize(request.signal);
        return null;
      },
      element: <WorkspaceLayout />,
      errorElement: <WorkspaceFailure />,
      hydrateFallbackElement: <p role="status">Loading workspaces…</p>,
      children: [
        {
          index: true,
          loader: ({ request }) => loadWorkspaces(directory, request),
          action: ({ request }) => mutateWorkspace(directory, ui, request),
          element: <WorkspaceList ui={ui} />,
          errorElement: <WorkspaceFailure />,
        },
        {
          path: "workspaces/:workspaceId",
          loader: ({ params: { workspaceId }, request }) =>
            loadWorkspace(directory, workspaceId, request),
          element: (
            <WorkspaceDetail WorkspaceManagement={WorkspaceManagement} />
          ),
          errorElement: <WorkspaceFailure />,
        },
        {
          path: "*",
          element: <WorkspaceFailure message="Page not found." />,
        },
      ],
    },
  ]);
  return router;
}
