import { redirect } from "react-router";
import { z } from "zod";
import {
  type WorkspaceDirectory,
  WorkspaceError,
  workspaceIdSchema,
  workspaceNameSchema,
  workspacePageSize,
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
  request: Request,
) {
  const parsed = z.coerce
    .number()
    .int()
    .min(1)
    .max(100_000)
    .safeParse(new URL(request.url).searchParams.get("page") ?? 1);
  const page = parsed.success ? parsed.data : 1;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
  const result = await directory.list(page, signal);
  signal.throwIfAborted();
  if (page > 1 && result.items.length === 0)
    throw redirect(
      `/?page=${Math.max(1, Math.ceil(result.totalCount / workspacePageSize))}`,
    );
  return { ...result, page };
}

export async function loadWorkspace(
  directory: WorkspaceDirectory,
  id: unknown,
  request: Request,
) {
  const parsed = workspaceIdSchema.safeParse(id);
  if (!parsed.success) throw new WorkspaceError("NOT_FOUND");
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
  const workspace = await directory.open(parsed.data, signal);
  signal.throwIfAborted();
  return workspace;
}

const mutationSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("create"), name: workspaceNameSchema }),
  z.object({ intent: z.literal("delete"), id: workspaceIdSchema }),
]);

type MutationResult =
  | { readonly kind: "success" }
  | { readonly kind: "failure"; readonly message: string };

export async function mutateWorkspace(
  directory: WorkspaceDirectory,
  ui: WorkspaceStore,
  request: Request,
): Promise<MutationResult> {
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
  try {
    const form = await request.formData();
    signal.throwIfAborted();
    const parsed = mutationSchema.safeParse(Object.fromEntries(form));
    if (!parsed.success) throw new WorkspaceError("INVALID_INPUT");
    switch (parsed.data.intent) {
      case "create":
        await directory.create(parsed.data.name, signal);
        break;
      case "delete":
        await directory.remove(parsed.data.id, signal);
        break;
    }
    signal.throwIfAborted();
    ui.getState().closeDialog();
    return { kind: "success" };
  } catch (cause) {
    if (request.signal.aborted) throw request.signal.reason;
    return { kind: "failure", message: workspaceErrorMessage(cause) };
  }
}
