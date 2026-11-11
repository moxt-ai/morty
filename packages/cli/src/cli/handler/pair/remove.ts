import type { Command } from "commander";

import { reloadDaemon } from "../../../daemon/lifecycle/daemon.ts";
import { openMortyInstallation } from "../../../daemon/pairing/pair-local-computer.ts";
import type { CliContext } from "../../context.ts";

export function registerPairRemoveCommand(command: Command, context: CliContext): void {
    command
        .command("remove")
        .description("remove the current pairing")
        .action(async () => {
            const installation = await openMortyInstallation(context.shutdownSignal, process.env);
            const pairing = await installation.currentConnection(context.shutdownSignal);
            if (pairing === null) {
                command.error("No computer is paired. Run Morty setup first.", { code: "connection_not_found" });
            }
            await installation.removeConnection(pairing.pairingGeneration, context.shutdownSignal);
            await reloadDaemon(installation.stateDirectory, context.shutdownSignal);
            process.stdout.write("Pairing removed.\n");
        });
}
