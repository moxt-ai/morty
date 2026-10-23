import {
    anonymousCredentialsEntry,
    type ComputerDestination,
    centralLocalStorage,
    MAX_REMEMBERED_COMPUTERS,
    type RememberedComputer,
    rememberedComputersEntry,
} from "../local-storage/central-local-storage.ts";
import { encodeIdentityScope, type IdentityScope } from "./identity-scope-url.ts";

export type { ComputerDestination, RememberedComputer };

export const computerKey = (scope: IdentityScope): string => encodeIdentityScope(scope);

/**
 * The computers this browser can open, most recently used first. This list owns which computers are kept; a user's
 * token is kept while a remembered computer needs it. Tokens no computer has claimed yet, such as those saved before
 * computers were remembered, only fill the room the list leaves.
 */
export function rememberedComputers(): readonly RememberedComputer[] {
    const credentials = storedCredentials();
    return (centralLocalStorage.read(rememberedComputersEntry) ?? []).filter(
        (computer) => computer.scope.userId in credentials,
    );
}

/** The token this browser holds for a user, if any of its computers may still be opened. */
export function storedToken(userId: string): string | null {
    return storedCredentials()[userId] ?? null;
}

/** Whether this browser holds any access at all, including access saved before computers were remembered. */
export function hasStoredAccess(): boolean {
    return Object.keys(storedCredentials()).length > 0;
}

/** Keeps a newly issued access: its token, and its computer behind those already visited. */
export function saveAccess(scope: IdentityScope, token: string): void {
    updateComputers(withComputer(rememberedComputers(), scope), { userId: scope.userId, token });
}

/** Keeps a computer whose stored access was just confirmed. */
export function rememberComputer(scope: IdentityScope): void {
    const saved = rememberedComputers();
    if (!saved.some((computer) => computerKey(computer.scope) === computerKey(scope))) {
        updateComputers(withComputer(saved, scope));
    }
}

export function forgetComputer(scope: IdentityScope): void {
    updateComputers(rememberedComputers().filter((computer) => computerKey(computer.scope) !== computerKey(scope)));
}

export function rememberComputerVisit(
    scope: IdentityScope,
    now: number,
    destination?: ComputerDestination,
    directory?: string,
): void {
    const saved = withComputer(rememberedComputers(), scope);
    const current = saved.find((computer) => computerKey(computer.scope) === computerKey(scope));
    if (current === undefined) {
        return;
    }
    updateComputers([
        {
            ...current,
            destination: destination ?? current.destination,
            directory: directory?.slice(0, 4096) ?? current.directory,
            lastUsedAt: now,
        },
        ...saved.filter((computer) => computerKey(computer.scope) !== computerKey(scope)),
    ]);
}

/** Background metadata changes must not change which computer was last used. */
export function rememberComputerName(scope: IdentityScope, name: string): void {
    updateComputers(
        rememberedComputers().map((computer) =>
            computerKey(computer.scope) === computerKey(scope)
                ? { ...computer, name: name.trim().slice(0, 256) }
                : computer,
        ),
    );
}

export function computerAddress(scope: IdentityScope, destination: ComputerDestination): string {
    const query = new URLSearchParams({ identity: encodeIdentityScope(scope) });
    if (destination.kind === "session") {
        query.set("sessionId", destination.sessionId);
    }
    return `/chat?${query}`;
}

function storedCredentials(): Readonly<Record<string, string>> {
    return centralLocalStorage.read(anonymousCredentialsEntry) ?? {};
}

/** The list with this computer in it. A new computer goes last, which makes room by dropping the least recent one. */
function withComputer(saved: readonly RememberedComputer[], scope: IdentityScope): readonly RememberedComputer[] {
    if (saved.some((computer) => computerKey(computer.scope) === computerKey(scope))) {
        return saved;
    }
    // A credential alone does not establish a successful visit. Keep it behind
    // previously visited computers until the application opens this access.
    return [
        ...saved.slice(0, MAX_REMEMBERED_COMPUTERS - 1),
        { scope, destination: { kind: "home" }, name: "", directory: null, lastUsedAt: 0 },
    ];
}

/**
 * The one place the saved computers change. A token leaves with the last computer that needed it, so a token is never
 * dropped while its computer is listed, and never outlives the computers it opened.
 */
function updateComputers(
    computers: readonly RememberedComputer[],
    added?: { readonly userId: string; readonly token: string },
): void {
    const previous = new Set(rememberedComputers().map((computer) => computer.scope.userId));
    const needed = new Set(computers.map((computer) => computer.scope.userId));
    const credentials = Object.entries(storedCredentials()).filter(
        ([userId]) => userId !== added?.userId && (needed.has(userId) || !previous.has(userId)),
    );
    if (added !== undefined) {
        credentials.push([added.userId, added.token]);
    }
    // Unclaimed tokens give way first, oldest first. The list's own limit leaves room for every token it needs.
    let excess = credentials.length - MAX_REMEMBERED_COMPUTERS;
    const kept = credentials.filter(([userId]) => {
        if (excess <= 0 || needed.has(userId)) {
            return true;
        }
        excess -= 1;
        return false;
    });
    if (kept.length === 0) {
        centralLocalStorage.remove(anonymousCredentialsEntry);
    } else {
        centralLocalStorage.write(anonymousCredentialsEntry, Object.fromEntries(kept));
    }
    centralLocalStorage.write(rememberedComputersEntry, computers);
}
