import type { Command } from "commander";

import { reloadDaemon } from "../../../daemon/lifecycle/daemon.ts";
import { openMortyCliInstallation, openMortyControlInstallation } from "../../../daemon/pairing/pair-local-machine.ts";
import type { CliContext } from "../../context.ts";
import { valueOption } from "../../util/options.ts";
import type { ConnectionOptions } from "./logic/options.ts";

export function registerPairStopCommand(command: Command, context: CliContext): void {
    command
        .command("stop")
        .description("stop a saved pairing")
        .addOption(valueOption("--connection <connection-id>", "saved Runtime connection identifier", true))
        .action(async (options: ConnectionOptions) => {
            const installation = await openMortyCliInstallation(context.shutdownSignal, process.env);
            await installation.setConnectionActivation(options.connection, "stopped", context.shutdownSignal);
            const control = await openMortyControlInstallation(context.shutdownSignal, process.env);
            await reloadDaemon(control.stateDirectory, context.shutdownSignal);
            process.stdout.write(`Pairing stopped: ${options.connection}\n`);
        });
}
