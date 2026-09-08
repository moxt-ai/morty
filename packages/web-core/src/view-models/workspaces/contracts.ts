import * as v from "valibot";

export const workspaceIdSchema = v.pipe(
  v.string(),
  v.regex(/^org_[A-Za-z0-9]+$/u),
);
export const workspaceNameSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(100),
);

export const workspaceIdentitySchema = v.pipe(
  v.object({
    id: workspaceIdSchema,
    name: v.pipe(v.string(), v.minLength(1)),
  }),
  v.readonly(),
);

export const workspaceSchema = v.pipe(
  v.object({
    id: workspaceIdSchema,
    name: v.pipe(v.string(), v.minLength(1)),
    canDelete: v.boolean(),
  }),
  v.readonly(),
);
export type Workspace = v.InferOutput<typeof workspaceSchema>;

export const workspacePageSchema = v.pipe(
  v.object({
    items: v.pipe(v.array(workspaceSchema), v.readonly()),
    totalCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
  }),
  v.readonly(),
);
type WorkspacePage = v.InferOutput<typeof workspacePageSchema>;

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
