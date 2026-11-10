import type { Command } from "commander";
import type { CliContext } from "../../context.ts";
import { valueOption } from "../../util/options.ts";

interface SetupOptions {
    readonly baseUrl?: string;
    readonly cwd?: string;
    readonly harness?: string;
    readonly sessionId?: string;
    readonly replaceComputer?: string;
    readonly deviceAccess?: string;
}

export function registerSetupHandlers(program: Command, context: CliContext): void {
    const run = async (args: readonly string[]) => {
        const { runSetup } = await import("../../../setup/setup.ts");
        process.exitCode = await runSetup(args, {
            state: process.env["MORTY_STATE_DIRECTORY"] ?? "",
            cliEntry: context.entry,
            signal: context.shutdownSignal,
            emit: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
        });
    };

    program
        .command("setup")
        .description("connect this Agent session and print a browser handoff link and QR image")
        .addOption(valueOption("--base-url <origin>", "Morty origin (default: https://morty.build)"))
        .addOption(valueOption("--cwd <directory>", "absolute working directory (default: current directory)"))
        .addOption(valueOption("--harness <id>", "Agent harness: codex, claude, or pi"))
        .addOption(valueOption("--session-id <id>", "session ID when the harness does not expose it"))
        .addOption(
            valueOption(
                "--replace-computer <id>",
                "replace this computer only after approval to revoke earlier access",
            ),
        )
        .addOption(
            valueOption("--device-access <duration>", "browser access duration: 1h, 1d, 7d, or 30d (default: 1d)"),
        )
        .action(async (options: SetupOptions) => {
            await run([
                "setup",
                "--base-url",
                options.baseUrl ?? "https://morty.build",
                "--cwd",
                options.cwd ?? process.cwd(),
                ...[
                    ["--harness", options.harness],
                    ["--session-id", options.sessionId],
                    ["--replace-computer", options.replaceComputer],
                    ["--device-access", options.deviceAccess],
                ].flatMap(([flag, value]) => (flag === undefined || value === undefined ? [] : [flag, value])),
            ]);
        });

    program
        .command("revoke-all-access")
        .description("revoke this computer's previously shared links and browser access without stopping its tasks")
        .addOption(
            valueOption("--base-url <origin>", "must match the saved Morty origin (defaults to the saved origin)"),
        )
        .action(async (options: { readonly baseUrl?: string }) => {
            await run(["revoke-all-access", ...(options.baseUrl === undefined ? [] : ["--base-url", options.baseUrl])]);
        });
}
