import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const markerName = "morty-installation.json";
const marker = JSON.stringify({ product: "morty", generation: 3 });

class MortyOwnershipError extends Error {
    readonly code = "morty_state_not_owned";
}

function missing(cause: unknown): boolean {
    return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

/** Called before setup, control or Computer writes. Never adopt an unmarked nonempty directory. */
export async function claimMortyState(root: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await mkdir(root, { recursive: true, mode: 0o700 });
    const metadata = await lstat(root);
    if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        (process.getuid !== undefined && metadata.uid !== process.getuid())
    ) {
        throw new MortyOwnershipError("Morty requires a private user-owned directory");
    }
    const path = join(root, markerName);
    const verify = async (): Promise<boolean> => {
        try {
            const stat = await lstat(path);
            if (!stat.isFile() || stat.isSymbolicLink()) {
                throw new MortyOwnershipError("Invalid Morty ownership marker");
            }
            const value: unknown = JSON.parse(await readFile(path, { encoding: "utf8", signal }));
            if (
                typeof value !== "object" ||
                value === null ||
                !("product" in value) ||
                value.product !== "morty" ||
                !("generation" in value) ||
                value.generation !== 3
            ) {
                throw new MortyOwnershipError("This directory belongs to another installation generation");
            }
            return true;
        } catch (cause) {
            if (missing(cause)) {
                return false;
            }
            throw cause;
        }
    };
    if (await verify()) {
        return;
    }
    const entries = await readdir(root);
    if (entries.some((entry) => !entry.startsWith(".morty-marker-"))) {
        // Another initializer can publish its marker between the first read and this listing.
        if (await verify()) {
            return;
        }
        throw new MortyOwnershipError(
            "Use a new empty Morty state directory and pair again; existing data is not adopted",
        );
    }
    const temporary = join(root, `.morty-marker-${randomUUID()}`);
    try {
        await writeFile(temporary, marker, { flag: "wx", mode: 0o600, signal });
        try {
            await link(temporary, path);
        } catch (cause) {
            if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) {
                throw cause;
            }
        }
        if (!(await verify())) {
            throw new MortyOwnershipError("Morty ownership marker disappeared");
        }
    } finally {
        await rm(temporary, { force: true });
    }
}
