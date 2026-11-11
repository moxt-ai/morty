import type { Command } from "commander";
import { reloadDaemon } from "../../../daemon/lifecycle/daemon.ts";
import { ensureDaemon } from "../../../daemon/lifecycle/daemon-client.ts";
import { openMortyInstallation } from "../../../daemon/pairing/pair-local-computer.ts";
import type { CliContext } from "../../context.ts";

export function registerStartCommand(program: Command, context: CliContext): void {
    program
        .command("start")
        .description("ensure the daemon is running and activate the current pairing")
        .action(async () => {
            const control = await openMortyInstallation(context.shutdownSignal, process.env);
            const pairing = await control.currentConnection(context.shutdownSignal);
            if (pairing !== null) {
                await control.setConnectionActivation(pairing.pairingGeneration, "active", context.shutdownSignal);
            }
            await ensureDaemon(control.stateDirectory, context.entry, context.shutdownSignal);
            await reloadDaemon(control.stateDirectory, context.shutdownSignal);
            process.stdout.write("Morty daemon is running.\n");
        });
}
