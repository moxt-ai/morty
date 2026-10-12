import { join } from "node:path";
import { documentsCommand } from "./documents-command.ts";

export const documentsDirectory = (signal: AbortSignal): Promise<string> =>
    documentsCommand(
        join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-Command", '[Environment]::GetFolderPath("MyDocuments")'],
        signal,
    );
