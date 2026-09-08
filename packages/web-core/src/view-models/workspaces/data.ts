import * as v from "valibot";
import {
  type WorkspaceDirectory,
  WorkspaceError,
  workspaceIdSchema,
  workspaceNameSchema,
} from "./contracts.ts";
import type { WorkspaceStore } from "./store.ts";

export function workspaceErrorMessage(cause: unknown): string {
  if (cause instanceof DOMException && cause.name === "TimeoutError") {
    return "The request timed out. Refresh workspaces to check the result before trying again.";
  }
  if (cause instanceof WorkspaceError) {
    switch (cause.code) {
      case "NOT_FOUND":
        return "This workspace is unavailable or you no longer have access.";
      case "FORBIDDEN":
        return "You don't have permission to perform this action. Refresh to check your access.";
      case "INVALID_INPUT":
        return "Enter a workspace name of 1–100 characters.";
      case "LIMIT_REACHED":
        return "The workspace limit has been reached. Please try again later or contact your administrator.";
      case "UNAVAILABLE":
        return "Workspaces are temporarily unavailable. Refresh to check the result before trying again.";
    }
  }
  return "Workspaces are temporarily unavailable. Please try again.";
}

export async function loadWorkspaces(
  directory: WorkspaceDirectory,
  requestedPage: unknown,
  requestSignal: AbortSignal,
) {
  const parsed = v.safeParse(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100_000)),
    requestedPage,
  );
  const page = parsed.success ? parsed.output : 1;
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(15_000)]);
  const result = await directory.list(page, signal);
  signal.throwIfAborted();
  return { ...result, page };
}

export async function loadWorkspace(
  directory: WorkspaceDirectory,
  id: unknown,
  requestSignal: AbortSignal,
) {
  const parsed = v.safeParse(workspaceIdSchema, id);
  if (!parsed.success) throw new WorkspaceError("NOT_FOUND");
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(15_000)]);
  const workspace = await directory.open(parsed.output, signal);
  signal.throwIfAborted();
  return workspace;
}

const mutationSchema = v.variant("intent", [
  v.object({ intent: v.literal("create"), name: workspaceNameSchema }),
  v.object({ intent: v.literal("delete"), id: workspaceIdSchema }),
]);

export type MutationResult =
  | { readonly kind: "success" }
  | { readonly kind: "failure"; readonly message: string };

export async function mutateWorkspace(
  directory: WorkspaceDirectory,
  ui: WorkspaceStore,
  form: FormData,
  requestSignal: AbortSignal,
): Promise<MutationResult> {
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(15_000)]);
  try {
    signal.throwIfAborted();
    const parsed = v.safeParse(mutationSchema, Object.fromEntries(form));
    if (!parsed.success) throw new WorkspaceError("INVALID_INPUT");
    switch (parsed.output.intent) {
      case "create":
        await directory.create(parsed.output.name, signal);
        break;
      case "delete":
        await directory.remove(parsed.output.id, signal);
        break;
    }
    signal.throwIfAborted();
    ui.getState().closeDialog();
    return { kind: "success" };
  } catch (cause) {
    if (requestSignal.aborted) throw requestSignal.reason;
    return { kind: "failure", message: workspaceErrorMessage(cause) };
  }
}
