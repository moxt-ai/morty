import { type ChildProcess, execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import type { ProcessPlatformSupport, ProcessTableEntry, ProcessTreeIdentity, SpawnedProcess } from "./contracts.ts";

const PROCESS_TABLE_TIMEOUT_MILLISECONDS = 1_000;
const PROCESS_TABLE_OUTPUT_LIMIT_BYTES = 1024 * 1024;

function parseProcessTable(output: string): readonly ProcessTableEntry[] {
    const entries: ProcessTableEntry[] = [];
    for (const line of output.split("\n")) {
        const groups = /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<pgid>\d+)\s*$/.exec(line)?.groups;
        if (groups === undefined) {
            continue;
        }
        const processId = Number(groups["pid"]);
        const parentProcessId = Number(groups["ppid"]);
        const processGroupId = Number(groups["pgid"]);
        if (
            !Number.isSafeInteger(processId) ||
            processId <= 0 ||
            !Number.isSafeInteger(parentProcessId) ||
            parentProcessId < 0 ||
            !Number.isSafeInteger(processGroupId) ||
            processGroupId <= 0
        ) {
            continue;
        }
        entries.push({ parentProcessId, processGroupId, processId });
    }
    return entries;
}

export function readProcessTableWithPs(executable: string): Promise<readonly ProcessTableEntry[]> {
    return new Promise((resolveTable) => {
        execFile(
            executable,
            ["-axo", "pid=,ppid=,pgid="],
            {
                encoding: "utf8",
                maxBuffer: PROCESS_TABLE_OUTPUT_LIMIT_BYTES,
                signal: AbortSignal.timeout(PROCESS_TABLE_TIMEOUT_MILLISECONDS),
                timeout: PROCESS_TABLE_TIMEOUT_MILLISECONDS,
            },
            (error, stdout) => {
                resolveTable(error === null ? parseProcessTable(stdout) : []);
            },
        );
    });
}

/**
 * POSIX reparents orphans and keeps a process group's ID reserved while the group has members, so the root's
 * process group and parent links identify its tree.
 */
function selectPosixProcessTree(
    entries: readonly ProcessTableEntry[],
    rootProcessId: number,
): readonly ProcessTreeIdentity[] {
    const processIds = new Set([rootProcessId]);
    for (const entry of entries) {
        if (entry.processGroupId === rootProcessId) {
            processIds.add(entry.processId);
        }
    }
    let previousSize = 0;
    while (previousSize !== processIds.size) {
        previousSize = processIds.size;
        for (const entry of entries) {
            if (processIds.has(entry.parentProcessId)) {
                processIds.add(entry.processId);
            }
        }
    }
    return entries
        .filter((entry) => processIds.has(entry.processId))
        .map((entry) => ({
            processGroupId: entry.processGroupId,
            processId: entry.processId,
        }));
}

export function posixProcessTreeCapture(
    readSynchronously: () => readonly ProcessTableEntry[],
    read: () => Promise<readonly ProcessTableEntry[]>,
): (root: SpawnedProcess) => Promise<readonly ProcessTreeIdentity[]> {
    return async (root) => {
        const entries = readSynchronously();
        return selectPosixProcessTree(entries.length > 0 ? entries : await read(), root.processId);
    };
}

export function processExists(processId: number): boolean {
    try {
        process.kill(processId, 0);
        return true;
    } catch {
        return false;
    }
}

function signalCapturedProcesses(
    processes: readonly ProcessTreeIdentity[],
    rootProcessId: number,
    signal: number,
): void {
    const processIds = new Set(processes.map((identity) => identity.processId));
    const signalledGroups = new Set<number>();
    for (const identity of processes) {
        const isRootProcessGroup = identity.processGroupId === rootProcessId;
        if (
            (!isRootProcessGroup && !processIds.has(identity.processGroupId)) ||
            signalledGroups.has(identity.processGroupId)
        ) {
            continue;
        }
        try {
            process.kill(-identity.processGroupId, signal);
            signalledGroups.add(identity.processGroupId);
        } catch {
            // A concurrently exited group no longer needs cleanup.
        }
    }
    for (const identity of processes) {
        if (
            identity.processId === rootProcessId ||
            identity.processGroupId === rootProcessId ||
            signalledGroups.has(identity.processGroupId)
        ) {
            continue;
        }
        try {
            process.kill(identity.processId, signal);
        } catch {
            // A concurrently exited process no longer needs cleanup.
        }
    }
}

function terminateProcess(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
        return;
    }
    try {
        process.kill(-child.pid, signal);
        return;
    } catch {
        // Fall through when the child did not create a process group.
    }
    child.kill(signal);
}

export const posixOperations = {
    pathDelimiter: ":",
    environmentValue: (environment: Readonly<NodeJS.ProcessEnv>, name: string) => environment[name],
    executableExtensions: () => [""],
    resolveExecutableTarget: async (path: string) => {
        const target = await realpath(path);
        await access(target, constants.X_OK);
        return target;
    },
    executableLaunch: (command: string, args: readonly string[]) => ({ command, arguments: args }),
    spawnOptions: { detached: true, windowsHide: true },
    signalCapturedProcesses,
    terminateProcess,
} satisfies Pick<
    ProcessPlatformSupport,
    | "pathDelimiter"
    | "environmentValue"
    | "executableExtensions"
    | "resolveExecutableTarget"
    | "executableLaunch"
    | "spawnOptions"
    | "signalCapturedProcesses"
    | "terminateProcess"
>;
