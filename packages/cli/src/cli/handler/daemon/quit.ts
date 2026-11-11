import type { Command } from "commander";

import { stopDaemon } from "../../../daemon/lifecycle/daemon-client.ts";
import { openMortyInstallation } from "../../../daemon/pairing/pair-local-machine.ts";
import type { CliContext } from "../../context.ts";

export function registerQuitCommand(program: Command, context: CliContext): void {
    program
        .command("stop")
        .alias("quit")
        .description("stop the daemon and every active Computer")
        .action(async () => {
            const installation = await openMortyInstallation(context.shutdownSignal, process.env);
            await stopDaemon(installation.stateDirectory, context.shutdownSignal);
            process.stdout.write("Morty daemon stopped.\n");
        });
}
