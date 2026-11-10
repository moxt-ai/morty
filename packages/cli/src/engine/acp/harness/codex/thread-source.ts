import { createReadStream } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { AcpExecutionError } from "../../acp-error.ts";

const metadataSchema = z.object({
    type: z.literal("session_meta"),
    payload: z.object({ id: z.string().max(256), thread_source: z.string().max(256).nullish() }),
});

/** Codex versions that omit threadSource in summaries still persist it in the rollout header. */
export async function readCodexThreadSource(
    home: string,
    path: string,
    threadId: string,
    signal: AbortSignal,
): Promise<string | null> {
    try {
        signal.throwIfAborted();
        const root = resolve(home, "sessions");
        const withinRoot = (target: string, base: string): boolean => {
            const remainder = relative(base, target);
            return (
                remainder !== "" && remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder)
            );
        };
        const resolvedRoot = await realpath(root);
        if (!isAbsolute(path) || (!withinRoot(path, root) && !withinRoot(path, resolvedRoot))) {
            throw new Error("Rollout path is outside Codex sessions");
        }
        const resolvedPath = await realpath(path);
        if (!withinRoot(resolvedPath, resolvedRoot)) {
            throw new Error("Resolved rollout path is outside Codex sessions");
        }
        const stream = createReadStream(resolvedPath, { encoding: "utf8", start: 0, end: 65_535, signal });
        try {
            let header = "";
            for await (const chunk of stream) {
                header += chunk;
                const newline = header.indexOf("\n");
                if (newline === -1) {
                    continue;
                }
                const decoded: unknown = JSON.parse(header.slice(0, newline));
                const metadata = metadataSchema.parse(decoded);
                if (metadata.payload.id !== threadId) {
                    throw new Error("Rollout identity mismatch");
                }
                return metadata.payload.thread_source ?? null;
            }
            throw new Error("Missing bounded rollout header");
        } finally {
            stream.destroy();
        }
    } catch (cause) {
        signal.throwIfAborted();
        throw new AcpExecutionError(
            "Codex session metadata could not be read",
            { cause },
            "codex_session_metadata_invalid",
        );
    }
}
