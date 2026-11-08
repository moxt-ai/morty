import type { ProcessPlatformSupport } from "./contracts.ts";
import { posixOperations, posixProcessTreeCapture, processExists, readProcessTableWithPs } from "./posix.ts";

export const macosProcessPlatform: ProcessPlatformSupport = {
    ...posixOperations,
    readProcessTable: () => readProcessTableWithPs("/bin/ps"),
    captureProcessTree: posixProcessTreeCapture(
        () => [],
        () => readProcessTableWithPs("/bin/ps"),
    ),
    processExists,
};
