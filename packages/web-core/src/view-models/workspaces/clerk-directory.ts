import type { BrowserClerk } from "@clerk/react";
import { isClerkAPIResponseError } from "@clerk/react/errors";
import * as v from "valibot";
import {
    type WorkspaceDirectory,
    WorkspaceError,
    workspaceIdentitySchema,
    workspaceIdSchema,
    workspaceNameSchema,
    workspacePageSchema,
    workspacePageSize,
    workspaceSchema,
} from "./contracts.ts";

const createWorkspaceErrorSchema = v.object({
    error: v.object({
        code: v.picklist([
            "INVALID_INPUT",
            "UNAUTHENTICATED",
            "WORKSPACES_TIMEOUT",
            "WORKSPACES_UNAVAILABLE",
            "UNAVAILABLE",
        ]),
    }),
});

// Clerk owns the HTTP requests and does not expose AbortSignal. Stop waiting
// on cancellation, but never retry mutations: their remote outcome may differ.
export function waitForClerk<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
        const abort = () => {
            signal.removeEventListener("abort", abort);
            reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        void Promise.resolve()
            .then(() => {
                signal.throwIfAborted();
                return operation();
            })
            .then(resolve, (cause: unknown) => {
                if (signal.aborted) {
                    reject(signal.reason);
                } else if (cause instanceof WorkspaceError) {
                    reject(cause);
                } else if (isClerkAPIResponseError(cause)) {
                    const code =
                        cause.status === 403 || cause.status === 401
                            ? "FORBIDDEN"
                            : cause.status === 404
                              ? "NOT_FOUND"
                              : cause.status === 429
                                ? "LIMIT_REACHED"
                                : cause.status === 400 || cause.status === 422
                                  ? "INVALID_INPUT"
                                  : "UNAVAILABLE";
                    reject(new WorkspaceError(code, { cause }));
                } else {
                    reject(new WorkspaceError("UNAVAILABLE", { cause }));
                }
            })
            .finally(() => signal.removeEventListener("abort", abort));
    });
}

type WorkspaceClerk = Pick<BrowserClerk, "getOrganization" | "session" | "setActive" | "user">;

export function clerkDirectory(clerk: WorkspaceClerk): WorkspaceDirectory {
    return {
        list: (page, signal) =>
            waitForClerk(async () => {
                if (!clerk.user) {
                    throw new WorkspaceError("FORBIDDEN");
                }
                const memberships = await clerk.user.getOrganizationMemberships({
                    initialPage: page,
                    pageSize: workspacePageSize,
                });
                return v.parse(workspacePageSchema, {
                    items: memberships.data.map(({ organization, permissions }) => ({
                        id: organization.id,
                        name: organization.name,
                        canDelete: organization.adminDeleteEnabled && permissions.includes("org:sys_profile:delete"),
                    })),
                    totalCount: memberships.total_count,
                });
            }, signal),
        create: (name, signal) =>
            waitForClerk(async () => {
                const parsed = v.safeParse(workspaceNameSchema, name);
                if (!parsed.success) {
                    throw new WorkspaceError("INVALID_INPUT");
                }
                const session = clerk.session;
                if (!session) {
                    throw new WorkspaceError("FORBIDDEN");
                }
                const token = await session.getToken();
                signal.throwIfAborted();
                if (!token) {
                    throw new WorkspaceError("FORBIDDEN");
                }
                const response = await fetch("/mobius-cloud/api/workspaces", {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${token}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({ name: parsed.output }),
                    signal,
                });
                const body: unknown = await response.json();
                if (response.ok) {
                    const workspace = v.parse(workspaceSchema, body);
                    await clerk.setActive({ organization: workspace.id });
                    signal.throwIfAborted();
                    const refreshedToken = await session.getToken({ skipCache: true });
                    signal.throwIfAborted();
                    if (!refreshedToken) {
                        throw new WorkspaceError("FORBIDDEN");
                    }
                    return workspace;
                }
                const error = v.safeParse(createWorkspaceErrorSchema, body);
                if (!error.success) {
                    throw new WorkspaceError("UNAVAILABLE");
                }
                switch (error.output.error.code) {
                    case "INVALID_INPUT":
                        throw new WorkspaceError("INVALID_INPUT");
                    case "UNAUTHENTICATED":
                        throw new WorkspaceError("FORBIDDEN");
                    case "UNAVAILABLE":
                    case "WORKSPACES_TIMEOUT":
                    case "WORKSPACES_UNAVAILABLE":
                        throw new WorkspaceError("UNAVAILABLE");
                }
            }, signal),
        open: (id, signal) =>
            waitForClerk(async () => {
                if (!v.safeParse(workspaceIdSchema, id).success) {
                    throw new WorkspaceError("NOT_FOUND");
                }
                // Clerk verifies membership when making an Organization active. An
                // arbitrary URL cannot select an Organization belonging to someone else.
                await clerk.setActive({ organization: id });
                signal.throwIfAborted();
                const organization = await clerk.getOrganization(id);
                return v.parse(workspaceIdentitySchema, organization);
            }, signal),
        remove: (id, signal) =>
            waitForClerk(async () => {
                if (!v.safeParse(workspaceIdSchema, id).success) {
                    throw new WorkspaceError("NOT_FOUND");
                }
                const organization = await clerk.getOrganization(id);
                signal.throwIfAborted();
                // This user-authenticated Clerk operation enforces delete permission
                // remotely, including when the user's role changed after listing.
                await organization.destroy();
            }, signal),
    };
}
