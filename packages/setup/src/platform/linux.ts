import { documentsCommand } from "./documents-command.ts";

export const documentsDirectory = (signal: AbortSignal): Promise<string> =>
    documentsCommand("xdg-user-dir", ["DOCUMENTS"], signal);
