import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    const root = await mkdtemp(join(tmpdir(), "morty-daemon-lock-"));
    cleanups.push(async () => await rm(root, { force: true, recursive: true }));
    return installationDirectory(root);
}

/** Contenders wait at a process boundary so concurrency does not depend on sleeps or wall-clock timing. */
function contender(directory: string): {
    readonly child: ChildProcess;
    readonly ready: Promise<void>;
    readonly start: () => void;
    readonly outcome: Promise<string>;
} {
    const child = spawn(
        process.execPath,
        [
            "--input-type=module",
            "--eval",
            `
        import { once } from "node:events";
        const { acquireDaemonLock } = await import(${JSON.stringify(lockModule)});
        process.stdout.write("ready\\n");
        await once(process.stdin, "data");
        const release = await acquireDaemonLock(${JSON.stringify(directory)});
        process.stdout.write(release === null ? "lost\\n" : "won\\n");
        process.stdin.resume();
    `,
        ],
        { stdio: ["pipe", "pipe", "inherit"] },
    );
    cleanups.push(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
            await once(child, "exit");
        }
    });
    const lines = createInterface({ input: child.stdout ?? process.stdin })[Symbol.asyncIterator]();
    const ready = lines.next().then(({ value }) => {
        expect(value).toBe("ready");
    });
    return {
        child,
        ready,
        start: () => {
            child.stdin?.write("start\n");
        },
        outcome: ready.then(async () => String((await lines.next()).value)),
    };
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
    await writeFile(join(directory, "daemon.lock"), `${(await deadProcessId()).toString()}\n`);

    const contenders = Array.from({ length: 6 }, () => contender(directory));
    await Promise.all(contenders.map(({ ready }) => ready));
    for (const candidate of contenders) {
        candidate.start();
    }
    const outcomes = await Promise.all(contenders.map(({ outcome }) => outcome));

    expect(outcomes.filter((outcome) => outcome === "won")).toHaveLength(1);
    const winner = contenders[outcomes.indexOf("won")]?.child.pid;
    expect(await readFile(join(directory, "daemon.lock"), "utf8")).toBe(`${String(winner)}\n`);
});

test("Given an unowned PID file names another live process, When the current daemon starts, Then the PID file cannot claim ownership", async () => {
    const directory = await stateDirectory();
    await writeFile(join(directory, "daemon.lock"), `${process.pid.toString()}\n`);

    const release = await acquireDaemonLock(directory);

    expect(release).not.toBeNull();
    await release?.();
});

test("Given a running daemon, When another daemon starts and the running one then stops, Then the newcomer gave up instead of taking over", async () => {
    const directory = await stateDirectory();
    const running = await acquireDaemonLock(directory);
    expect(running).not.toBeNull();

    const newcomer = contender(directory);
    await newcomer.ready;
    newcomer.start();
    expect(await newcomer.outcome).toBe("lost");
    await running?.();
    expect(await daemonLockExists(directory)).toBe(false);
});
