const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const execute = promisify(execFile);

function isAlive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 1) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function stopProcess(pid) {
    if (!isAlive(pid)) {
        return;
    }
    try {
        await execute(
            path.join(process.env.SystemRoot, "System32", "taskkill.exe"),
            ["/PID", String(pid), "/T", "/F"],
            {
                windowsHide: true,
                timeout: 10000,
                signal: AbortSignal.timeout(10000),
            },
        );
    } catch (cause) {
        if (isAlive(pid)) {
            throw cause;
        }
    }
}

function writeCommandShim(directory) {
    fs.writeFileSync(
        path.join(directory, "mobius.cmd"),
        '@ECHO off\r\nSET dp0=%~dp0\r\nSET "_prog=node"\r\n"%_prog%" "%dp0%\\mobius.cjs" %*\r\n',
    );
}

module.exports = { cliShimName: "mobius.cjs", writeCommandShim, stopProcess };
