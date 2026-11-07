import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { ensureDaemon, readDaemonVersion, stopDaemon } from "../../../daemon/lifecycle/daemon-client.ts";
import { openMortyControlInstallation } from "../../../daemon/pairing/pair-local-machine.ts";
import {
    executableDirectory,
    prepareRelease,
    readInstalledRelease,
    recordInstallationState,
    removeInstalledReleases,
    selectRelease,
} from "../../../installation/releases.ts";
import { acquireDaemonLock } from "../../../storage/daemon/daemon-lock.ts";
import type { CliContext } from "../../context.ts";

interface InstallOptions {
    readonly archive?: string;
    readonly version: string;
}

async function install(options: InstallOptions, context: CliContext): Promise<void> {
    const signal = AbortSignal.any([context.shutdownSignal, AbortSignal.timeout(180_000)]);
    const control = await openMortyControlInstallation(signal, process.env);
    const releaseLock = await acquireDaemonLock(control.stateDirectory, "installation.lock");
    if (releaseLock === null) {
        throw new Error("Another Morty installation operation is running; retry after it finishes");
    }
    let switched = false;
    let previous: Awaited<ReturnType<typeof readInstalledRelease>> = null;
    let running: string | null = null;
    try {
        previous = await readInstalledRelease(signal);
        await recordInstallationState({ kind: "preparing", previous }, signal);
        process.stdout.write("Preparing Morty release; the current service remains available.\n");
        const candidate = await prepareRelease(
            options.archive === undefined
                ? { kind: "registry", selector: options.version }
                : { kind: "archive", path: options.archive },
            signal,
        );
        await recordInstallationState({ kind: "verified", previous, candidate }, signal);
        running = await readDaemonVersion(control.stateDirectory, signal);
        if (running !== null) {
            await stopDaemon(control.stateDirectory, signal);
        }
        await selectRelease(candidate, signal);
        switched = true;
        await recordInstallationState({ kind: "switched", previous, candidate }, signal);
        if (running !== null) {
            const started = await ensureDaemon(control.stateDirectory, signal);
            if (started !== candidate.version) {
                throw new Error("A competing startup selected another Morty version");
            }
        }
        await recordInstallationState({ kind: "complete", installed: candidate }, signal);
        process.stdout.write(`Installed Morty ${candidate.version}. Run morty start to start the service.\n`);
    } catch (cause) {
        const recovery = AbortSignal.timeout(30_000);
        try {
            if (switched) {
                await stopDaemon(control.stateDirectory, recovery);
                if (previous !== null) {
                    await selectRelease(previous, recovery);
                    if (running !== null) {
                        await ensureDaemon(control.stateDirectory, recovery);
                    }
                } else {
                    await rm(join(executableDirectory(), "current.json"), { force: true });
                }
            } else if (running !== null && previous !== null) {
                await ensureDaemon(control.stateDirectory, recovery);
            }
            await recordInstallationState({ kind: "failed", recovered: true, installed: previous }, recovery);
        } catch (recoveryError) {
            await recordInstallationState({ kind: "failed", recovered: false, previous }, AbortSignal.timeout(5_000));
            throw new AggregateError(
                [cause, recoveryError],
                "Morty update failed and requires recovery; run morty doctor",
            );
        }
        throw cause;
    } finally {
        await releaseLock();
    }
}

export function registerInstallCommands(program: Command, context: CliContext): void {
    for (const name of ["install", "update"]) {
        program
            .command(name)
            .description(
                name === "install"
                    ? "install a verified release in Morty's durable directory"
                    : "install and switch to a verified Morty release",
            )
            .option(
                "--version <version>",
                "exact version or release channel",
                name === "install" ? context.version : "latest",
            )
            .option("--archive <path>", "install an independently verified local Morty npm archive")
            .action(async (options: InstallOptions) => await install(options, context));
    }
    program
        .command("uninstall")
        .description("stop Morty and remove its managed executables, retaining pairings and user data")
        .action(async () => {
            const signal = AbortSignal.any([context.shutdownSignal, AbortSignal.timeout(60_000)]);
            const control = await openMortyControlInstallation(signal, process.env);
            const releaseLock = await acquireDaemonLock(control.stateDirectory, "installation.lock");
            if (releaseLock === null) {
                throw new Error("Another Morty installation operation is running");
            }
            try {
                await stopDaemon(control.stateDirectory, signal);
                await removeInstalledReleases(signal);
                process.stdout.write(
                    "Morty stopped and managed executables removed. Pairings, workspaces and Agent history are retained.\n",
                );
            } finally {
                await releaseLock();
            }
        });
    program
        .command("doctor")
        .description("inspect the installed release and last installation operation")
        .action(async () => {
            const release = await readInstalledRelease(context.shutdownSignal);
            process.stdout.write(`Installed: ${release?.version ?? "not installed"}\n`);
            try {
                const operation = await readFile(join(executableDirectory(), "operation.json"), {
                    encoding: "utf8",
                    signal: context.shutdownSignal,
                });
                process.stdout.write(`Last installation operation: ${operation}\n`);
            } catch (cause) {
                if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) {
                    throw cause;
                }
            }
        });
}
