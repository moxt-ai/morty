import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { LocalPathError } from "../filesystem/path-error.ts";

const execute = promisify(execFile);

// Windows' default pipe ACL permits public read access, but only its owner, SYSTEM and administrators may write.
// No output is produced before token authentication. Check ownership before a client sends that token, and reject
// broader write ACLs instead of treating the pipe name as an authentication boundary.
const inspect = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ([IO.Directory]::GetFiles('\\.\pipe\') -notcontains ('\\.\pipe\' + $env:MORTY_PIPE_NAME)) { exit 3 }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$rights = [IO.Pipes.PipeAccessRights]::ReadWrite -bor [IO.Pipes.PipeAccessRights]::ReadPermissions
$pipe = New-Object IO.Pipes.NamedPipeClientStream('.', $env:MORTY_PIPE_NAME, $rights, [IO.Pipes.PipeOptions]::None, [Security.Principal.TokenImpersonationLevel]::Identification, [IO.HandleInheritability]::None)
try {
    $pipe.Connect(5000)
    $acl = $pipe.GetAccessControl()
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
    $administrator = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($owner -ne $sid -and -not ($owner.Value -eq 'S-1-5-32-544' -and $administrator)) { throw 'Control pipe is not user-owned' }
    $write = [IO.Pipes.PipeAccessRights]::Write -bor [IO.Pipes.PipeAccessRights]::CreateNewInstance -bor [IO.Pipes.PipeAccessRights]::Delete -bor [IO.Pipes.PipeAccessRights]::ChangePermissions -bor [IO.Pipes.PipeAccessRights]::TakeOwnership
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and ($rule.PipeAccessRights -band $write) -ne 0 -and $rule.IdentityReference.Value -notin @($sid.Value, 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-0')) {
            throw 'Control pipe grants another user write access'
        }
    }
} finally { $pipe.Dispose() }
`;

export async function validateWindowsPipe(path: string, signal: AbortSignal): Promise<void> {
    const systemRoot = Object.entries(process.env).find(([key]) => key.toLowerCase() === "systemroot")?.[1];
    if (systemRoot === undefined || !path.startsWith("\\\\.\\pipe\\morty-")) {
        throw new LocalPathError("Windows control pipe configuration is unavailable");
    }
    try {
        await execute(
            join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
            [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                Buffer.from(inspect, "utf16le").toString("base64"),
            ],
            {
                env: { ...process.env, MORTY_PIPE_NAME: path.slice("\\\\.\\pipe\\".length) },
                windowsHide: true,
                signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
                timeout: 10_000,
                maxBuffer: 16384,
            },
        );
    } catch (cause) {
        signal.throwIfAborted();
        if (cause instanceof Error && "code" in cause && cause.code === 3) {
            throw Object.assign(new Error("Morty control pipe is not running"), { code: "ENOENT" });
        }
        throw new LocalPathError(
            `The Morty control pipe ownership or access permissions could not be verified${cause instanceof Error && "stderr" in cause && typeof cause.stderr === "string" ? `: ${cause.stderr.slice(0, 1024).trim()}` : ""}`,
            {
                cause,
            },
        );
    }
}
