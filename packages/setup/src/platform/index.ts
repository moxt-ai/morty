import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export async function resolveDocumentsDirectory(configured: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    try {
        const directory = configured !== "" ? configured : join(homedir(), "Documents");
        if (!isAbsolute(directory)) {
            throw new Error("The Documents folder is unavailable or not absolute");
        }
        return directory;
    } catch (cause) {
        signal.throwIfAborted();
        throw Object.assign(new Error("Set DOCUMENT_DIR to an existing absolute Documents directory", { cause }), {
            code: "DOCUMENT_DIR_REQUIRED",
        });
    }
}
