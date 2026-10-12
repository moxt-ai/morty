import { isAbsolute } from "node:path";
import { documentsDirectory as linux } from "./linux.ts";
import { documentsDirectory as macos } from "./macos.ts";
import { documentsDirectory as windows } from "./windows.ts";

const documentsResolvers: Readonly<Record<string, (signal: AbortSignal) => Promise<string>>> = {
    linux,
    darwin: macos,
    win32: windows,
};

export async function resolveDocumentsDirectory(configured: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    try {
        const resolver = documentsResolvers[process.platform];
        const directory = configured !== "" ? configured : resolver === undefined ? "" : await resolver(signal);
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
