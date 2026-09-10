import {
    type Workspace,
    type WorkspaceDirectory,
    WorkspaceError,
    workspacePageSize,
} from "../../packages/web/src/cloud/index.ts";

// A stateful identity provider at the production directory port. Browser
// scenarios exercise workspace flows without live accounts or auth automation.
export class WorkspaceIdentityProvider {
    readonly #workspaces = new Map<
        string,
        {
            readonly name: string;
            readonly members: ReadonlyMap<string, "admin" | "member">;
        }
    >();
    #nextId = 1;
    #online = true;
    #openingPaused = false;
    readonly #pending = new Set<() => void>();
    readonly pauseOpening = () => {
        this.#openingPaused = true;
    };
    readonly resumeOpening = () => {
        this.#openingPaused = false;
        for (const resume of this.#pending) {
            resume();
        }
    };

    readonly disconnect = (): void => {
        this.#online = false;
    };
    readonly reconnect = (): void => {
        this.#online = true;
    };

    readonly create = (name: string, owner: string): string => {
        const id = `org_${this.#nextId++}`;
        this.#workspaces.set(id, { name, members: new Map([[owner, "admin"]]) });
        return id;
    };

    readonly invite = (id: string, user: string): void => {
        const workspace = this.#workspaces.get(id);
        if (!workspace) {
            throw new WorkspaceError("NOT_FOUND");
        }
        this.#workspaces.set(id, {
            ...workspace,
            members: new Map([...workspace.members, [user, "member"]]),
        });
    };

    readonly forUser = (user: string): WorkspaceDirectory => {
        const get = (id: string): Workspace => {
            const workspace = this.#workspaces.get(id);
            const role = workspace?.members.get(user);
            if (!workspace || !role) {
                throw new WorkspaceError("NOT_FOUND");
            }
            return { id, name: workspace.name, canDelete: role === "admin" };
        };
        return {
            list: async (page, signal) => {
                signal.throwIfAborted();
                if (!this.#online) {
                    throw new WorkspaceError("UNAVAILABLE");
                }
                const items = [...this.#workspaces]
                    .filter(([, workspace]) => workspace.members.has(user))
                    .map(([id]) => get(id));
                return {
                    items: items.slice((page - 1) * workspacePageSize, page * workspacePageSize),
                    totalCount: items.length,
                };
            },
            create: async (name, signal) => {
                signal.throwIfAborted();
                return get(this.create(name, user));
            },
            open: async (id, signal) => {
                signal.throwIfAborted();
                if (this.#openingPaused) {
                    await new Promise<void>((resolve, reject) => {
                        const cleanup = () => {
                            this.#pending.delete(resume);
                            signal.removeEventListener("abort", abort);
                        };
                        const resume = () => {
                            cleanup();
                            resolve();
                        };
                        const abort = () => {
                            cleanup();
                            reject(signal.reason);
                        };
                        this.#pending.add(resume);
                        signal.addEventListener("abort", abort, { once: true });
                    });
                }
                return get(id);
            },
            remove: async (id, signal) => {
                signal.throwIfAborted();
                if (!get(id).canDelete) {
                    throw new WorkspaceError("FORBIDDEN");
                }
                this.#workspaces.delete(id);
            },
        };
    };
}
