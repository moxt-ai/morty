import { appendFileSync } from "node:fs";
import { join } from "node:path";

// INVESTIGATION ONLY: record process events for the Windows lifecycle reproduction.
export function investigate(event: string, detail: Record<string, unknown> = {}): void {
    const directory = process.env["MORTY_INVESTIGATION_LOG"];
    if (directory !== undefined) {
        appendFileSync(
            join(directory, `${process.pid}.jsonl`),
            `${JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ppid: process.ppid, argv: process.argv.slice(2), event, ...detail })}\n`,
        );
    }
}
