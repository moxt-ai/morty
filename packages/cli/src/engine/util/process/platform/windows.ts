import { type ChildProcess, execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { ProcessExecutionError } from "../process-error.ts";
import type {
    ProcessLaunch,
    ProcessPlatformSupport,
    ProcessTableEntry,
    ProcessTreeIdentity,
    SpawnedProcess,
} from "./contracts.ts";
import { processExists } from "./posix.ts";

function environmentValue(environment: Readonly<NodeJS.ProcessEnv>, name: string): string | undefined {
    return Object.entries(environment).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1];
}

function executableExtensions(executableName: string, environment: Readonly<NodeJS.ProcessEnv>): readonly string[] {
    if (/\.[a-zA-Z0-9]+$/.test(executableName)) {
        return [""];
    }
    const configured = environmentValue(environment, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD";
    const extensions = configured
        .split(";")
        .map((extension) => extension.trim())
        .filter((extension) => extension.length > 0)
        .map((extension) => (extension.startsWith(".") ? extension : `.${extension}`));
    return extensions.length > 0 ? extensions : [".EXE"];
}

async function resolveExecutableTarget(path: string): Promise<string> {
    let resolvedPath: string;
    try {
        resolvedPath = await realpath(extname(path) === "" ? `${path}.cmd` : path);
    } catch (cause) {
        if (extname(path) !== "" || !(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") {
            throw cause;
        }
        resolvedPath = await realpath(path);
    }
    if (extname(resolvedPath).toLowerCase() === ".cmd") {
        // npm cmd-shim entrypoints are Node scripts. Resolve the script instead of
        // handing untrusted arguments to cmd.exe's command language.
        const shim = await readFile(resolvedPath, "utf8");
        // Node ships npm and npx with the same verified wrapper format.
        for (const tool of ["npm", "npx"]) {
            const variable = `${tool.toUpperCase()}_CLI_JS`;
            if (
                shim.includes(`SET "${variable}=%~dp0\\node_modules\\npm\\bin\\${tool}-cli.js"`) &&
                shim.includes(`"%NODE_EXE%" "%${variable}%" %*`)
            ) {
                return await realpath(resolve(dirname(resolvedPath), `node_modules/npm/bin/${tool}-cli.js`));
            }
        }
        const script = /"%_prog%"\s+"%dp0%[\\/]([^"\r\n]+\.(?:js|mjs|cjs))"\s+%\*/iu.exec(shim)?.[1];
        if (script !== undefined && shim.includes("SET dp0=%~dp0")) {
            resolvedPath = await realpath(resolve(dirname(resolvedPath), script));
        } else {
            const pnpmScript = /^\s*node\s+"%~dp0[\\/]([^"\r\n]+\.(?:js|mjs|cjs))"\s+%\*\s*$/imu.exec(shim)?.[1];
            if (pnpmScript === undefined || !shim.includes("@SETLOCAL")) {
                throw new ProcessExecutionError(
                    "process_unsupported_script",
                    "Use a native executable or a verified Node entrypoint",
                );
            }
            resolvedPath = await realpath(resolve(dirname(resolvedPath), pnpmScript));
        }
    }
    return resolvedPath;
}

function executableLaunch(command: string, args: readonly string[]): ProcessLaunch {
    if (/\.(?:js|mjs|cjs)$/iu.test(command)) {
        return { command: process.execPath, arguments: [command, ...args] };
    }
    if (/\.(?:cmd|bat)$/iu.test(command)) {
        throw new ProcessExecutionError(
            "process_unsupported_script",
            "Use a native executable or a verified Node entrypoint",
        );
    }
    return { command, arguments: args };
}

/** A running process; `createdAt` is its creation time in milliseconds since the Unix epoch. */
interface WindowsProcess {
    readonly processId: number;
    readonly parentProcessId: number;
    readonly createdAt: number;
}

function parseWindowsProcesses(output: string): readonly WindowsProcess[] {
    const processes: WindowsProcess[] = [];
    for (const line of output.split("\n")) {
        const groups = /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<created>\d+)\s*$/.exec(line)?.groups;
        if (groups === undefined) {
            continue;
        }
        const processId = Number(groups["pid"]);
        const parentProcessId = Number(groups["ppid"]);
        const createdAt = Number(groups["created"]);
        if (
            !Number.isSafeInteger(processId) ||
            processId <= 0 ||
            !Number.isSafeInteger(parentProcessId) ||
            parentProcessId < 0 ||
            !Number.isSafeInteger(createdAt)
        ) {
            continue;
        }
        processes.push({ processId, parentProcessId, createdAt });
    }
    return processes;
}

function readWindowsProcesses(): Promise<readonly WindowsProcess[]> {
    const systemRoot = environmentValue(process.env, "SystemRoot");
    if (systemRoot === undefined) {
        return Promise.resolve([]);
    }
    return new Promise((resolveTable) => {
        execFile(
            join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
            [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                // Processes without a creation time, such as the System process, are never part of a spawned tree.
                "Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds() }",
            ],
            {
                encoding: "utf8",
                windowsHide: true,
                timeout: 10000,
                signal: AbortSignal.timeout(10000),
                maxBuffer: 1024 * 1024,
            },
            (error, stdout) => resolveTable(error === null ? parseWindowsProcesses(stdout) : []),
        );
    });
}

async function readProcessTable(): Promise<readonly ProcessTableEntry[]> {
    return (await readWindowsProcesses()).map(({ processId, parentProcessId }) => ({
        processId,
        parentProcessId,
        processGroupId: processId,
    }));
}

/**
 * Windows reuses a process ID as soon as its process is gone and never updates a recorded parent ID, so a parent ID
 * alone can name an unrelated process. A process belongs to the most recent process with its parent's ID that was
 * created no later than itself. The running root is the child itself because its owner holds its handle, which keeps
 * its ID from being reused. A child of an exited root must have been created during the root's lifetime.
 */
function selectWindowsProcessTree(
    processes: readonly WindowsProcess[],
    root: SpawnedProcess,
): readonly ProcessTreeIdentity[] {
    const running = new Map(processes.map((entry) => [entry.processId, entry]));
    const members = new Set<number>();
    if (root.state === "running" && running.has(root.processId)) {
        members.add(root.processId);
    }
    const belongsToTree = (entry: WindowsProcess): boolean => {
        const parent = running.get(entry.parentProcessId);
        if (parent !== undefined && parent.createdAt <= entry.createdAt) {
            return members.has(parent.processId);
        }
        return (
            root.state === "exited" &&
            entry.parentProcessId === root.processId &&
            root.spawnedAt <= entry.createdAt &&
            entry.createdAt <= root.exitedAt
        );
    };
    let previousSize = -1;
    while (previousSize !== members.size) {
        previousSize = members.size;
        for (const entry of processes) {
            if (!members.has(entry.processId) && belongsToTree(entry)) {
                members.add(entry.processId);
            }
        }
    }
    return [...members].map((processId) => ({ processGroupId: processId, processId }));
}

async function captureProcessTree(root: SpawnedProcess): Promise<readonly ProcessTreeIdentity[]> {
    return selectWindowsProcessTree(await readWindowsProcesses(), root);
}

function signalCapturedProcesses(
    processes: readonly ProcessTreeIdentity[],
    _rootProcessId: number,
    signal: number,
): void {
    for (const identity of [...processes].reverse()) {
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
    child.kill(signal);
}

export const windowsProcessPlatform: ProcessPlatformSupport = {
    pathDelimiter: ";",
    environmentValue,
    executableExtensions,
    resolveExecutableTarget,
    executableLaunch,
    spawnOptions: { detached: false, windowsHide: true },
    signalCapturedProcesses,
    terminateProcess,
    readProcessTable,
    captureProcessTree,
    processExists,
};
