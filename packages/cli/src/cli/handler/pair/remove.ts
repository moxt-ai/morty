import type { Command } from "commander";

import { reloadDaemon } from "../../../daemon/lifecycle/daemon.ts";
import { openMortyInstallation } from "../../../daemon/pairing/pair-local-machine.ts";
import type { CliContext } from "../../context.ts";
import { valueOption } from "../../util/options.ts";
import type { ConnectionOptions } from "./logic/options.ts";

export function registerPairRemoveCommand(command: Command, context: CliContext): void {
    command
        .command("remove")
        .description("remove a saved pairing")
        .addOption(valueOption("--connection <connection-id>", "saved Runtime connection identifier", true))
        .action(async (options: ConnectionOptions) => {
            const installation = await openMortyInstallation(context.shutdownSignal, process.env);
            await installation.removeConnection(options.connection, context.shutdownSignal);
            await reloadDaemon(installation.stateDirectory, context.shutdownSignal);
            process.stdout.write(`Pairing removed: ${options.connection}\n`);
        });
}
