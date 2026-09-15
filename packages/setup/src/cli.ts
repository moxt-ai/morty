import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { runSetup } from "./setup.ts";

export { runSetup };

if (process.argv[1] !== undefined && pathToFileURL(await realpath(process.argv[1])).href === import.meta.url) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
        process.exitCode = await runSetup(process.argv.slice(2), {
            documents: process.env.DOCUMENT_DIR ?? "",
            signal: controller.signal,
            emit: (value) => console.log(JSON.stringify(value)),
        });
    } finally {
        process.removeListener("SIGINT", cancel);
        process.removeListener("SIGTERM", cancel);
    }
}
