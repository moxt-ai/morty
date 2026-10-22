import {
    anonymousCredentialsEntry,
    type ComputerDestination,
    centralLocalStorage,
    type RememberedComputer,
    rememberedComputersEntry,
} from "../local-storage/central-local-storage.ts";
import { encodeIdentityScope, type IdentityScope } from "./identity-scope-url.ts";

export type { ComputerDestination, RememberedComputer };

export const computerKey = (scope: IdentityScope): string => encodeIdentityScope(scope);

export function rememberedComputers(): readonly RememberedComputer[] {
    const credentials = centralLocalStorage.read(anonymousCredentialsEntry) ?? {};
    return (centralLocalStorage.read(rememberedComputersEntry) ?? []).filter(
        (computer) => computer.scope.userId in credentials,
    );
}

export function rememberComputer(scope: IdentityScope): void {
    const saved = rememberedComputers();
    if (saved.some((computer) => computerKey(computer.scope) === computerKey(scope))) {
        return;
    }
    // A credential alone does not establish a successful visit. Keep it behind
    // previously visited computers until the application opens this access.
    centralLocalStorage.write(rememberedComputersEntry, [
        ...saved.slice(0, 9),
        { scope, destination: { kind: "home" }, name: "", directory: null, lastUsedAt: 0 },
    ]);
}

export function forgetComputer(scope: IdentityScope): void {
    centralLocalStorage.write(
        rememberedComputersEntry,
        rememberedComputers().filter((computer) => computerKey(computer.scope) !== computerKey(scope)),
    );
}

export function rememberComputerVisit(
    scope: IdentityScope,
    now: number,
    destination?: ComputerDestination,
    directory?: string,
): void {
    rememberComputer(scope);
    const saved = rememberedComputers();
    const current = saved.find((computer) => computerKey(computer.scope) === computerKey(scope));
    if (current === undefined) {
        return;
    }
    centralLocalStorage.write(rememberedComputersEntry, [
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
    centralLocalStorage.write(
        rememberedComputersEntry,
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
