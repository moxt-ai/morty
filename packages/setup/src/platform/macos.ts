import { documentsCommand } from "./documents-command.ts";

export const documentsDirectory = (signal: AbortSignal): Promise<string> =>
    documentsCommand("/usr/bin/osascript", ["-e", "POSIX path of (path to documents folder)"], signal);
