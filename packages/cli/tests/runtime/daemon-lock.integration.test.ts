import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, expect, test } from "vitest";
import { installationDirectory } from "../../src/engine/storage/installation/installation-files.ts";
import { acquireDaemonLock, daemonLockExists } from "../../src/storage/daemon/daemon-lock.ts";

const lockModule = new URL("../../src/storage/daemon/daemon-lock.ts", import.meta.url).href;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
    }
});

async function stateDirectory() {
    const root = await mkdtemp(join(tmpdir(), "mobius-daemon-lock-"));
    cleanups.push(async () => await rm(root, { force: true, recursive: true }));
    const directory = installationDirectory(root, "installation");
    await mkdir(directory);
    return directory;
}

/** A process that tries to become the daemon at `startAt` and keeps whatever it took until it is killed. */
function contender(
    directory: string,
    startAt: number,
): { readonly child: ChildProcess; readonly outcome: Promise<string> } {
    const child = spawn(
        process.execPath,
        [
            "--input-type=module",
            "--eval",
            `const { acquireDaemonLock } = await import(${JSON.stringify(lockModule)});
            while (Date.now() < ${startAt}) {}
            const release = await acquireDaemonLock(${JSON.stringify(directory)});
            process.stdout.write(release === null ? "lost\\n" : "won\\n");
            setInterval(() => {}, 60_000);`,
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
    );
    cleanups.push(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
            await once(child, "exit");
        }
    });
    const lines = createInterface({ input: child.stdout ?? process.stdin });
    return { child, outcome: once(lines, "line").then(([line]) => String(line)) };
}

async function deadProcessId(): Promise<number> {
    const child = spawn(process.execPath, ["--eval", ""], { stdio: "ignore" });
    await once(child, "exit");
    if (child.pid === undefined) {
        throw new Error("The probe process has no PID");
    }
    return child.pid;
}

test("Given a lock a crashed daemon left, When several daemons start at once, Then exactly one becomes the daemon", async () => {
    const directory = await stateDirectory();
    await writeFile(join(directory, "manager.lock"), `${(await deadProcessId()).toString()}\n`);

    const startAt = Date.now() + 1_000;
    const contenders = Array.from({ length: 6 }, () => contender(directory, startAt));
    const outcomes = await Promise.all(contenders.map(({ outcome }) => outcome));

    expect(outcomes.filter((outcome) => outcome === "won")).toHaveLength(1);
    const winner = contenders[outcomes.indexOf("won")]?.child.pid;
    expect(await readFile(join(directory, "manager.lock"), "utf8")).toBe(`${String(winner)}\n`);
});

test("Given a daemon that crashed and whose PID now names a live process, When the next daemon starts, Then it replaces the lock its predecessor left", async () => {
    const directory = await stateDirectory();
    // This process held the lock and crashed: its lock file stays behind while its PID names a live process.
    const crashed = await acquireDaemonLock(directory);
    expect(crashed).not.toBeNull();
    await crashed?.();
    await writeFile(join(directory, "manager.lock"), `${process.pid.toString()}\n`);

    const release = await acquireDaemonLock(directory);

    expect(release).not.toBeNull();
    await release?.();
});

test("Given a running daemon, When another daemon starts and the running one then stops, Then the newcomer gave up instead of taking over", async () => {
    const directory = await stateDirectory();
    const running = await acquireDaemonLock(directory);
    expect(running).not.toBeNull();

    const startAt = Date.now() + 1_000;
    const newcomer = contender(directory, startAt);
    // The running daemon stops while the newcomer would still be waiting for the lock.
    await new Promise((resolve) => setTimeout(resolve, startAt + 300 - Date.now()));
    await running?.();

    expect(await newcomer.outcome).toBe("lost");
    expect(await daemonLockExists(directory)).toBe(false);
});
