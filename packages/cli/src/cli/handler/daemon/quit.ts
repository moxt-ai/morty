import type { Command } from "commander";

import { stopDaemon } from "../../../daemon/lifecycle/daemon-client.ts";
import { openMortyControlInstallation } from "../../../daemon/pairing/pair-local-machine.ts";
import type { CliContext } from "../../context.ts";

export function registerQuitCommand(program: Command, context: CliContext): void {
    program
        .command("stop")
        .alias("quit")
        .description("stop the daemon and every active Runtime")
        .action(async () => {
            const installation = await openMortyControlInstallation(context.shutdownSignal, process.env);
            await stopDaemon(installation.stateDirectory, context.shutdownSignal);
            process.stdout.write("Morty daemon stopped.\n");
        });
}
