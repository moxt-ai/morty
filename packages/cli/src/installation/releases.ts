import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import { writeInstallationFile } from "../engine/storage/installation/installation-files.ts";
import { validateLocalPath } from "../engine/util/filesystem/private-path.ts";
import { isNodeError } from "../engine/util/node-error.ts";
import { executableLaunch, findExecutableOnPath, runBoundedProcess } from "../engine/util/process/executable.ts";
import { readStateDirectory } from "../storage/state-directory.ts";

const versionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/);
const releaseSchema = z
    .object({
        product: z.literal("morty"),
        version: versionSchema,
        directory: z.string().regex(/^[0-9a-f-]{36}$/),
    })
    .readonly();
export type InstalledRelease = z.infer<typeof releaseSchema>;

class InstallationError extends Error {
    readonly code: "release_not_installed" | "release_invalid" | "npm_unavailable";
    constructor(code: InstallationError["code"], message: string, options?: ErrorOptions) {
        super(message, options);
        this.code = code;
    }
}

export function executableDirectory(): string {
    return join(readStateDirectory(), "executables");
}

export function releaseEntry(release: InstalledRelease): string {
    return join(
        executableDirectory(),
        "releases",
        release.directory,
        "node_modules",
        "@morty-build",
        "cli",
        "dist",
        "cli.js",
    );
}

export async function readInstalledRelease(signal: AbortSignal): Promise<InstalledRelease | null> {
    const path = join(executableDirectory(), "current.json");
    try {
        await validateLocalPath(path, false, true, signal);
        const value: unknown = JSON.parse(await readFile(path, { encoding: "utf8", signal }));
        const release = releaseSchema.parse(value);
        await verifyRelease(release, signal);
        return release;
    } catch (cause) {
        if (isNodeError(cause, "ENOENT")) {
            return null;
        }
        throw new InstallationError("release_invalid", "The installed Morty release is invalid; run morty install", {
            cause,
        });
    }
}

export async function requireInstalledRelease(signal: AbortSignal): Promise<InstalledRelease> {
    const release = await readInstalledRelease(signal);
    if (release === null) {
        throw new InstallationError("release_not_installed", "Run morty install before starting the service");
    }
    return release;
}

async function verifyRelease(release: InstalledRelease, signal: AbortSignal): Promise<void> {
    const directory = join(executableDirectory(), "releases", release.directory);
    await validateLocalPath(directory, true, true, signal);
    const entry = releaseEntry(release);
    await validateLocalPath(entry, false, false, signal);
    if ((await realpath(entry)) !== join(await realpath(directory), relative(directory, entry))) {
        throw new InstallationError("release_invalid", "Morty release contains a redirected entrypoint");
    }
    const manifest: unknown = JSON.parse(
        await readFile(join(directory, "node_modules", "@morty-build", "cli", "package.json"), {
            encoding: "utf8",
            signal,
        }),
    );
    z.object({
        name: z.literal("@morty-build/cli"),
        version: z.literal(release.version),
        bin: z.object({ morty: z.literal("dist/cli.js") }),
    }).parse(manifest);
}

async function npm(arguments_: readonly string[], signal: AbortSignal): Promise<string> {
    const command = await findExecutableOnPath("npm", process.env);
    if (command === null) {
        throw new InstallationError("npm_unavailable", "Install Node.js with npm before installing Morty");
    }
    const launch = executableLaunch(command.path, arguments_);
    const result = await runBoundedProcess({
        command: launch.command,
        arguments: launch.arguments,
        cwd: readStateDirectory(),
        environment: process.env,
        signal,
        timeoutMilliseconds: 120_000,
        outputLimitBytes: 2 * 1024 * 1024,
    });
    return result.stdout;
}

export type ReleaseSelection =
    | { readonly kind: "registry"; readonly selector: string }
    | { readonly kind: "archive"; readonly path: string };

/** Resolve a tag once, then let npm check the exact package's registry integrity during installation. */
export async function prepareRelease(selection: ReleaseSelection, signal: AbortSignal): Promise<InstalledRelease> {
    let specifier: string;
    let expectedVersion: string | null = null;
    if (selection.kind === "registry") {
        if (!/^(?:latest|next|\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)$/.test(selection.selector)) {
            throw new InstallationError("release_invalid", "Select latest, next, or an exact Morty version");
        }
        const response: unknown = JSON.parse(
            await npm(["view", `@morty-build/cli@${selection.selector}`, "version", "--json"], signal),
        );
        expectedVersion = versionSchema.parse(response);
        specifier = `@morty-build/cli@${expectedVersion}`;
    } else {
        specifier = await realpath(resolve(selection.path));
        await validateLocalPath(specifier, false, false, signal);
    }
    const id = randomUUID();
    const directory = join(executableDirectory(), "releases", id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
        await npm(
            [
                "install",
                "--prefix",
                directory,
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
                "--omit=dev",
                "--save-exact",
                specifier,
            ],
            signal,
        );
        const manifest: unknown = JSON.parse(
            await readFile(join(directory, "node_modules", "@morty-build", "cli", "package.json"), {
                encoding: "utf8",
                signal,
            }),
        );
        const parsed = z.object({ name: z.literal("@morty-build/cli"), version: versionSchema }).parse(manifest);
        if (expectedVersion !== null && parsed.version !== expectedVersion) {
            throw new InstallationError("release_invalid", "Downloaded version differs from the selected release");
        }
        const release: InstalledRelease = { product: "morty", version: parsed.version, directory: id };
        await verifyRelease(release, signal);
        await runBoundedProcess({
            command: process.execPath,
            arguments: [releaseEntry(release), "--help"],
            cwd: directory,
            environment: process.env,
            signal,
            timeoutMilliseconds: 20_000,
        });
        return release;
    } catch (cause) {
        await rm(directory, { recursive: true, force: true });
        signal.throwIfAborted();
        throw new InstallationError(
            "release_invalid",
            "Morty release installation failed; the selected release was not changed",
            { cause },
        );
    }
}

export async function selectRelease(release: InstalledRelease, signal: AbortSignal): Promise<void> {
    await verifyRelease(release, signal);
    await writeInstallationFile(join(executableDirectory(), "current.json"), JSON.stringify(release), signal);
}

export async function recordInstallationState(
    value: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
): Promise<void> {
    await writeInstallationFile(join(executableDirectory(), "operation.json"), JSON.stringify(value), signal);
}

/** Remove only verified Morty release directories; persistent state and unrelated entries remain. */
export async function removeInstalledReleases(signal: AbortSignal): Promise<void> {
    const root = join(executableDirectory(), "releases");
    let entries: Dirent[];
    try {
        entries = await readdir(root, { withFileTypes: true });
    } catch (cause) {
        if (isNodeError(cause, "ENOENT")) {
            return;
        }
        throw cause;
    }
    for (const entry of entries) {
        signal.throwIfAborted();
        if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) {
            continue;
        }
        const directory = join(root, entry.name);
        const manifest: unknown = JSON.parse(
            await readFile(join(directory, "node_modules", "@morty-build", "cli", "package.json"), {
                encoding: "utf8",
                signal,
            }),
        );
        const parsed = z.object({ name: z.literal("@morty-build/cli"), version: versionSchema }).parse(manifest);
        await verifyRelease({ product: "morty", version: parsed.version, directory: entry.name }, signal);
        await rm(directory, { recursive: true });
    }
    await rm(join(executableDirectory(), "current.json"), { force: true });
    await recordInstallationState({ kind: "uninstalled", persistentStateRetained: true }, signal);
}
