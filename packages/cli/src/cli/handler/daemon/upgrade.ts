import type { Command } from "commander";
import { ensureDaemon, stopDaemon } from "../../../daemon/lifecycle/daemon-client.ts";
import { openMortyControlInstallation } from "../../../daemon/pairing/pair-local-machine.ts";
import type { CliContext } from "../../context.ts";

export function registerUpgradeCommand(program: Command, context: CliContext): void {
    program
        .command("restart")
        .description("restart the daemon using the installed Morty release")
        .action(async () => {
            const control = await openMortyControlInstallation(context.shutdownSignal, process.env);
            await stopDaemon(control.stateDirectory, context.shutdownSignal);
            const version = await ensureDaemon(control.stateDirectory, context.version, context.shutdownSignal);
            process.stdout.write(`Morty daemon ${version} restarted.\n`);
        });
}
