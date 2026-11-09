import { addAbortSignal, type Readable } from "node:stream";
import type { Command } from "commander";

export interface ParsedPairOptions {
    readonly code?: string;
    readonly codeStdin?: boolean;
    readonly pairing?: string;
    readonly url?: string;
    readonly workspace?: string;
}

export interface PairOptions extends ParsedPairOptions {
    readonly code: string;
    readonly url: string;
}

export interface ConnectionOptions {
    readonly connection: string;
}

export interface PairListOptions {
    readonly outputJson?: string;
}

function requireOption(value: string | undefined, flags: string, command: Command): string {
    if (value === undefined) {
        command.error(`required option '${flags}' not specified`, {
            code: "commander.missingMandatoryOptionValue",
        });
    }
    return value;
}

/** A pairing code is a few dozen characters; anything longer is not one. */
const MAX_PIPED_CODE_BYTES = 1024;

/**
 * Reads the pairing code piped to the command. A code given this way never appears in the process list, where other
 * users of the same computer could read and redeem it.
 */
async function readPipedCode(input: Readable, command: Command, signal: AbortSignal): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of addAbortSignal(signal, input)) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_PIPED_CODE_BYTES) {
            command.error("the pairing code read from standard input is too long", {
                code: "commander.invalidArgument",
            });
        }
        chunks.push(bytes);
    }
    const code = Buffer.concat(chunks).toString("utf8").trim();
    if (code.length === 0) {
        command.error("no pairing code was read from standard input", { code: "commander.invalidArgument" });
    }
    return code;
}

export async function requirePairOptions(
    options: ParsedPairOptions,
    command: Command,
    input: Readable,
    signal: AbortSignal,
): Promise<PairOptions> {
    return {
        ...options,
        code:
            options.codeStdin === true
                ? await readPipedCode(input, command, signal)
                : requireOption(options.code, "--code <pairing-code>", command),
        url: requireOption(options.url, "--url <relay-url>", command),
    };
}

export function pairArguments(options: PairOptions): readonly string[] {
    return [
        "--url",
        options.url,
        "--code",
        options.code,
        ...(options.pairing === undefined ? [] : ["--computer", options.pairing]),
        ...(options.workspace === undefined ? [] : ["--workspace", options.workspace]),
    ];
}
