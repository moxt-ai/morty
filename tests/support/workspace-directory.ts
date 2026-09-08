import {
  type Workspace,
  type WorkspaceDirectory,
  WorkspaceError,
  workspacePageSize,
} from "@moxt-ai/mobius-cloud-web-core";

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
    if (!workspace) throw new WorkspaceError("NOT_FOUND");
    this.#workspaces.set(id, {
      ...workspace,
      members: new Map([...workspace.members, [user, "member"]]),
    });
  };

  readonly forUser = (user: string): WorkspaceDirectory => {
    const get = (id: string): Workspace => {
      const workspace = this.#workspaces.get(id);
      const role = workspace?.members.get(user);
      if (!workspace || !role) throw new WorkspaceError("NOT_FOUND");
      return { id, name: workspace.name, canDelete: role === "admin" };
    };
    return {
      list: async (page, signal) => {
        signal.throwIfAborted();
        if (!this.#online) throw new WorkspaceError("UNAVAILABLE");
        const items = [...this.#workspaces]
          .filter(([, workspace]) => workspace.members.has(user))
          .map(([id]) => get(id));
        return {
          items: items.slice(
            (page - 1) * workspacePageSize,
            page * workspacePageSize,
          ),
          totalCount: items.length,
        };
      },
      create: async (name, signal) => {
        signal.throwIfAborted();
        return get(this.create(name, user));
      },
      open: async (id, signal) => {
        signal.throwIfAborted();
        return get(id);
      },
      remove: async (id, signal) => {
        signal.throwIfAborted();
        if (!get(id).canDelete) throw new WorkspaceError("FORBIDDEN");
        this.#workspaces.delete(id);
      },
    };
  };
}
