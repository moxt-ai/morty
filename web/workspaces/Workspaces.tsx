import type { ComponentType } from "react";
import {
  Link,
  useFetcher,
  useLoaderData,
  useLocation,
  useNavigate,
  useRevalidator,
  useRouteError,
} from "react-router";
import { useStore } from "zustand";
import { workspacePageSize } from "./contracts.ts";
import {
  type loadWorkspace,
  type loadWorkspaces,
  type mutateWorkspace,
  workspaceErrorMessage,
} from "./data.ts";
import type { WorkspaceStore } from "./store.ts";

const primaryButton =
  "rounded-lg bg-violet-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-800 disabled:opacity-50";
const secondaryButton =
  "rounded-lg border border-zinc-300 px-4 py-2.5 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50";

// A callback ref owns only the native dialog's DOM lifecycle, not data loading.
function openDialog(element: HTMLDialogElement | null) {
  if (!element) return;
  element.showModal();
  return () => element.close();
}

function WorkspaceDialog({ ui }: { readonly ui: WorkspaceStore }) {
  const dialog = useStore(ui, (state) => state.dialog);
  const close = useStore(ui, (state) => state.closeDialog);
  const setName = useStore(ui, (state) => state.setName);
  const fetcher = useFetcher<typeof mutateWorkspace>();
  const busy = fetcher.state !== "idle";
  if (dialog.kind === "closed") return null;

  return (
    <dialog
      ref={openDialog}
      aria-labelledby="workspace-dialog-title"
      className="m-auto w-[calc(100%-3rem)] max-w-md rounded-2xl border border-zinc-200 bg-white p-7 text-zinc-900 shadow-xl backdrop:bg-zinc-950/30"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <fetcher.Form method="post" action="/?index">
        <input type="hidden" name="intent" value={dialog.kind} />
        <h2
          id="workspace-dialog-title"
          className="text-xl font-semibold tracking-tight"
        >
          {dialog.kind === "create" ? "New workspace" : "Delete workspace?"}
        </h2>
        {dialog.kind === "create" ? (
          <div className="mt-6">
            <label
              htmlFor="workspace-name"
              className="mb-2 block text-sm font-medium"
            >
              Workspace name
            </label>
            <input
              id="workspace-name"
              name="name"
              value={dialog.name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
              required
              disabled={busy}
              placeholder="e.g. Research team"
              className="w-full rounded-lg border border-zinc-300 px-3 py-2.5 outline-violet-600"
            />
          </div>
        ) : (
          <>
            <input type="hidden" name="id" value={dialog.workspace.id} />
            <p className="mt-4 text-sm leading-6 text-zinc-600">
              Delete{" "}
              <strong className="break-words text-zinc-900">
                {dialog.workspace.name}
              </strong>{" "}
              and remove access for all its members? This cannot be undone.
            </p>
          </>
        )}
        {fetcher.data?.kind === "failure" && (
          <p role="alert" className="mt-4 text-sm text-red-700">
            {fetcher.data.message}
          </p>
        )}
        <div className="mt-7 flex justify-end gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={close}
            className={secondaryButton}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || (dialog.kind === "create" && !dialog.name.trim())}
            className={
              dialog.kind === "create"
                ? primaryButton
                : "rounded-lg bg-red-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-50"
            }
          >
            {busy
              ? "Saving…"
              : dialog.kind === "create"
                ? "Create workspace"
                : "Delete workspace"}
          </button>
        </div>
      </fetcher.Form>
    </dialog>
  );
}

export function WorkspaceList({ ui }: { readonly ui: WorkspaceStore }) {
  const { items, page, totalCount } = useLoaderData<typeof loadWorkspaces>();
  const newWorkspace = useStore(ui, (state) => state.newWorkspace);
  const confirmDelete = useStore(ui, (state) => state.confirmDelete);
  const dialog = useStore(ui, (state) => state.dialog);
  const revalidator = useRevalidator();

  return (
    <>
      <div className="mb-9 flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-violet-700">
            Mobius Cloud
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">Workspaces</h1>
          <p className="mt-3 text-zinc-500">
            A shared place for your team and agents.
          </p>
        </div>
        <button type="button" onClick={newWorkspace} className={primaryButton}>
          New workspace
        </button>
      </div>
      {items.length === 0 ? (
        <section className="rounded-2xl border border-dashed border-zinc-300 bg-white px-8 py-20 text-center">
          <h2 className="text-lg font-semibold">No workspaces yet</h2>
          <p className="mt-2 text-sm text-zinc-500">
            Create a workspace to get started.
          </p>
        </section>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((workspace) => (
            <li
              key={workspace.id}
              className="flex min-w-0 flex-col rounded-xl border border-zinc-200 bg-white shadow-sm"
            >
              <Link
                to={`/workspaces/${workspace.id}`}
                className="flex flex-1 items-center gap-4 rounded-t-xl p-6 hover:bg-violet-50/50 focus-visible:outline-violet-600"
              >
                <span
                  aria-hidden="true"
                  className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-violet-100 text-lg font-semibold text-violet-800"
                >
                  {workspace.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="break-words font-semibold">
                  {workspace.name}
                </span>
              </Link>
              <div className="flex min-h-12 items-center justify-between border-t border-zinc-100 px-6 py-3 text-xs">
                <span className="text-zinc-500">Workspace</span>
                {workspace.canDelete && (
                  <button
                    type="button"
                    aria-label={`Delete ${workspace.name}`}
                    onClick={() => confirmDelete(workspace)}
                    className="text-zinc-500 hover:text-red-700"
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          disabled={revalidator.state !== "idle"}
          onClick={() => {
            void revalidator.revalidate();
          }}
          className="text-sm text-zinc-500 hover:text-zinc-900 disabled:opacity-50"
        >
          Refresh workspaces
        </button>
        {totalCount > workspacePageSize && (
          <nav aria-label="Workspace pages" className="flex items-center gap-4">
            {page > 1 ? (
              <Link to={`/?page=${page - 1}`} className={secondaryButton}>
                Previous
              </Link>
            ) : (
              <span className="text-sm text-zinc-400">Previous</span>
            )}
            <span className="text-sm text-zinc-500">Page {page}</span>
            {page * workspacePageSize < totalCount ? (
              <Link to={`/?page=${page + 1}`} className={secondaryButton}>
                Next
              </Link>
            ) : (
              <span className="text-sm text-zinc-400">Next</span>
            )}
          </nav>
        )}
      </div>
      {dialog.kind !== "closed" && <WorkspaceDialog ui={ui} />}
    </>
  );
}

export function WorkspaceDetail({
  WorkspaceManagement,
}: {
  readonly WorkspaceManagement: ComponentType;
}) {
  const workspace = useLoaderData<typeof loadWorkspace>();
  return (
    <>
      <Link
        to="/"
        className="text-sm font-medium text-zinc-500 hover:text-zinc-900"
      >
        ← All workspaces
      </Link>
      <section className="mt-8">
        <p className="mb-3 break-words text-sm font-medium text-violet-700">
          {workspace.name}
        </p>
        <div className="mt-6">
          <WorkspaceManagement />
        </div>
      </section>
    </>
  );
}

export function WorkspaceFailure({ message }: { readonly message?: string }) {
  const cause: unknown = useRouteError();
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <>
      <Link
        to="/"
        className="text-sm font-medium text-zinc-500 hover:text-zinc-900"
      >
        ← All workspaces
      </Link>
      <p
        role="alert"
        className="mt-8 rounded-xl border border-red-200 bg-white p-6 text-red-700"
      >
        {message ?? workspaceErrorMessage(cause)}
      </p>
      <button
        type="button"
        onClick={() => {
          void navigate(`${location.pathname}${location.search}`, {
            replace: true,
          });
        }}
        className="mt-5 text-sm text-zinc-500"
      >
        Refresh workspaces
      </button>
    </>
  );
}
