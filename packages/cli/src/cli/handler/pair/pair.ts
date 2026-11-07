import { type Command, Option } from "commander";
import { reloadDaemon } from "../../../daemon/lifecycle/daemon.ts";
import { ensureDaemon } from "../../../daemon/lifecycle/daemon-client.ts";
import {
    openMortyCliInstallation,
    openMortyControlInstallation,
    pairLocalMachine,
} from "../../../daemon/pairing/pair-local-machine.ts";
import type { CliContext } from "../../context.ts";
import { valueOption } from "../../util/options.ts";
import { type ParsedPairOptions, pairArguments, requirePairOptions } from "./logic/options.ts";

export function registerPairAction(command: Command, context: CliContext): void {
    command
        .addOption(valueOption("--url <relay-url>", "relay HTTP or HTTPS URL"))
        .addOption(valueOption("--code <pairing-code>", "pairing code shown in the browser"))
        .addOption(
            new Option("--code-stdin", "read the pairing code from standard input instead of --code").conflicts("code"),
        )
        .addOption(valueOption("--pairing <runtime-pairing-id>", "Runtime pairing identifier"))
        .addOption(valueOption("--workspace <directory>", "default workspace directory"))
        .action(async (options: ParsedPairOptions) => {
            const requested = await requirePairOptions(options, command, process.stdin, context.shutdownSignal);
            const control = await openMortyControlInstallation(context.shutdownSignal, process.env);
            await ensureDaemon(control.stateDirectory, context.version, context.shutdownSignal);
            const installation = await openMortyCliInstallation(context.shutdownSignal, process.env);
            process.stdout.write(`morty version: ${context.version}\n`);
            const paired = await pairLocalMachine(pairArguments(requested), context.shutdownSignal);
            const connection = await installation.setConnectionActivation(
                paired.connectionId,
                "active",
                context.shutdownSignal,
            );
            await reloadDaemon(control.stateDirectory, context.shutdownSignal);
            process.stdout.write(
                `\nLocal machine paired.\nApp ID: ${connection.appId}\nConnection ID: ${connection.connectionId}\n`,
            );
            process.stdout.write("Morty daemon is running; connection will reconnect automatically.\n");
        });
}
