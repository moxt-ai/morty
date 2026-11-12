import type { Command } from "commander";
import { ensureDaemon, stopDaemon } from "../../../daemon/lifecycle/daemon-client.ts";
import { openMortyInstallation } from "../../../daemon/pairing/pair-local-computer.ts";
import type { CliContext } from "../../context.ts";

export function registerUpgradeCommand(program: Command, context: CliContext): void {
    program
        .command("restart")
        .description("restart the daemon using this Morty CLI release")
        .action(async () => {
            const control = await openMortyInstallation(context.shutdownSignal, process.env);
            await stopDaemon(control.stateDirectory, context.shutdownSignal);
            const daemon = await ensureDaemon(
                control.stateDirectory,
                context.entry,
                process.env,
                context.shutdownSignal,
            );
            process.stdout.write(`Morty daemon ${daemon.version} restarted.\n`);
        });
}
