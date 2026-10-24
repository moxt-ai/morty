import {
    anonymousCredentialsEntry,
    type ComputerDestination,
    centralLocalStorage,
    MAX_REMEMBERED_COMPUTERS,
    type RememberedComputer,
    readableComputer,
    readableCredential,
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
    return openable(readStoredAccess());
}

/** The token this browser holds for a user, if any of its computers may still be opened. */
export function storedToken(userId: string): string | null {
    return readStoredAccess().credentials.get(userId) ?? null;
}

/** Whether this browser holds any access at all, including access saved before computers were remembered. */
export function hasStoredAccess(): boolean {
    return readStoredAccess().credentials.size > 0;
}

/** Keeps a newly issued access: its token, and its computer behind those already visited. */
export function saveAccess(scope: IdentityScope, token: string): void {
    updateComputers(withComputer(rememberedComputers(), scope), { added: { userId: scope.userId, token } });
}

/** Keeps a computer whose stored access was just confirmed. */
export function rememberComputer(scope: IdentityScope): void {
    const saved = rememberedComputers();
    if (!saved.some((computer) => computerKey(computer.scope) === computerKey(scope))) {
        updateComputers(withComputer(saved, scope));
    }
}

/** Drops access that no longer opens this computer, listed or not, with its token unless another computer needs it. */
export function forgetComputer(scope: IdentityScope): void {
    updateComputers(
        rememberedComputers().filter((computer) => computerKey(computer.scope) !== computerKey(scope)),
        { released: scope.userId },
    );
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

/** Marks an address this browser built from what it remembers, rather than a link someone gave the user. */
const RESUME_PARAMETER = "resume";

/**
 * The address that continues on a computer where this browser left it. The remembered place is only a hint: if it is
 * gone, the computer opens at its chat home, as when the user returns through the plain address.
 */
export function resumeComputerAddress(scope: IdentityScope, destination: ComputerDestination): string {
    return `${computerAddress(scope, destination)}&${RESUME_PARAMETER}=1`;
}

/** Whether an address continues where this browser left a computer; reading it removes the marker from the address. */
export function takeResumeMarker(): boolean {
    const address = new URL(window.location.href);
    if (!address.searchParams.has(RESUME_PARAMETER)) {
        return false;
    }
    address.searchParams.delete(RESUME_PARAMETER);
    window.history.replaceState(window.history.state, "", address);
    return true;
}

/**
 * Everything this browser stores about its access, read entry by entry. Another Morty version may store tokens or
 * computer records this version cannot read; they are kept aside and written back untouched, never dropped.
 */
interface StoredAccess {
    readonly credentials: ReadonlyMap<string, string>;
    readonly unreadableCredentials: Readonly<Record<string, unknown>>;
    readonly computers: readonly RememberedComputer[];
    readonly unreadableComputers: readonly unknown[];
    /** The users of computer records this version cannot read, as far as their records say. */
    readonly unreadableComputerUsers: ReadonlySet<string>;
}

/** Whose computer a record this version cannot read is, when it still names its user the way this version does. */
function recordedUser(record: unknown): string | null {
    if (typeof record !== "object" || record === null || !("scope" in record)) {
        return null;
    }
    const scope = record.scope;
    if (typeof scope !== "object" || scope === null || !("userId" in scope)) {
        return null;
    }
    return typeof scope.userId === "string" ? scope.userId : null;
}

function readStoredAccess(): StoredAccess {
    const credentials = new Map<string, string>();
    const unreadableCredentials: Record<string, unknown> = {};
    for (const [userId, token] of Object.entries(centralLocalStorage.read(anonymousCredentialsEntry) ?? {})) {
        const readable = readableCredential(userId, token);
        if (readable === null) {
            unreadableCredentials[userId] = token;
        } else {
            credentials.set(userId, readable);
        }
    }
    const computers: RememberedComputer[] = [];
    const unreadableComputers: unknown[] = [];
    for (const record of centralLocalStorage.read(rememberedComputersEntry) ?? []) {
        const readable = readableComputer(record);
        if (readable === null) {
            unreadableComputers.push(record);
        } else {
            computers.push(readable);
        }
    }
    const unreadableComputerUsers = new Set(
        unreadableComputers.map(recordedUser).filter((userId): userId is string => userId !== null),
    );
    return { credentials, unreadableCredentials, computers, unreadableComputers, unreadableComputerUsers };
}

/** The computers this version can open: those whose token it can read. */
function openable(stored: StoredAccess): readonly RememberedComputer[] {
    return stored.computers.filter((computer) => stored.credentials.has(computer.scope.userId));
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
 * The one place the saved computers change. A token leaves with the last computer that needed it, or when its access
 * is found to be gone, so a token is never dropped while its computer is listed, and never outlives its access.
 */
function updateComputers(
    computers: readonly RememberedComputer[],
    change: {
        readonly added?: { readonly userId: string; readonly token: string };
        /** A user whose access ended, even if no listed computer held its token. */
        readonly released?: string;
    } = {},
): void {
    const { added, released } = change;
    const stored = readStoredAccess();
    const previous = new Set(openable(stored).map((computer) => computer.scope.userId));
    // Computer records this version cannot read are kept, so the tokens they name are needed as much as any other.
    const needed = new Set([...computers.map((computer) => computer.scope.userId), ...stored.unreadableComputerUsers]);
    const credentials = [...stored.credentials].filter(
        ([userId]) =>
            userId !== added?.userId && (needed.has(userId) || (!previous.has(userId) && userId !== released)),
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
    // What only another version can read stays as it was: its tokens, and the computers that need them.
    const unreadable = Object.fromEntries(
        Object.entries(stored.unreadableCredentials).filter(
            ([userId]) => !kept.some(([keptUserId]) => keptUserId === userId),
        ),
    );
    const theirs = stored.computers.filter(
        (computer) =>
            computer.scope.userId in unreadable &&
            !computers.some((listed) => computerKey(listed.scope) === computerKey(computer.scope)),
    );
    const allCredentials = { ...unreadable, ...Object.fromEntries(kept) };
    if (Object.keys(allCredentials).length === 0) {
        centralLocalStorage.remove(anonymousCredentialsEntry);
    } else {
        centralLocalStorage.write(anonymousCredentialsEntry, allCredentials);
    }
    centralLocalStorage.write(rememberedComputersEntry, [...computers, ...theirs, ...stored.unreadableComputers]);
}
