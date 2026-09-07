import { z } from "zod";

export const workspaceIdSchema = z.string().regex(/^org_[A-Za-z0-9]+$/);
export const workspaceNameSchema = z.string().trim().min(1).max(100);

export const workspaceIdentitySchema = z
  .object({
    id: workspaceIdSchema,
    name: z.string().min(1),
  })
  .readonly();

export const workspaceSchema = z
  .object({
    id: workspaceIdSchema,
    name: z.string().min(1),
    canDelete: z.boolean(),
  })
  .readonly();
export type Workspace = z.infer<typeof workspaceSchema>;

export const workspacePageSchema = z
  .object({
    items: z.array(workspaceSchema).readonly(),
    totalCount: z.number().int().nonnegative(),
  })
  .readonly();
type WorkspacePage = z.infer<typeof workspacePageSchema>;

// The signed-in identity provider is the authority for membership and deletion.
export interface WorkspaceDirectory {
  readonly list: (page: number, signal: AbortSignal) => Promise<WorkspacePage>;
  readonly create: (name: string, signal: AbortSignal) => Promise<Workspace>;
  readonly open: (
    id: string,
    signal: AbortSignal,
  ) => Promise<{ readonly id: string; readonly name: string }>;
  readonly remove: (id: string, signal: AbortSignal) => Promise<void>;
}

export const workspacePageSize = 20;

type WorkspaceErrorCode =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "LIMIT_REACHED"
  | "UNAVAILABLE";

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;

  constructor(code: WorkspaceErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.code = code;
    this.name = "WorkspaceError";
  }
}
