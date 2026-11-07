import type { Command } from "commander";
import { reloadDaemon } from "../../../daemon/lifecycle/daemon.ts";
import { ensureDaemon } from "../../../daemon/lifecycle/daemon-client.ts";
import { openMortyCliInstallation, openMortyControlInstallation } from "../../../daemon/pairing/pair-local-machine.ts";
import type { CliContext } from "../../context.ts";
import { valueOption } from "../../util/options.ts";

interface StartOptions {
    readonly connection?: string;
}

export function registerStartCommand(program: Command, context: CliContext): void {
    program
        .command("start")
        .description("ensure the daemon is running and optionally activate a saved connection")
        .addOption(valueOption("--connection <connection-id>", "saved Runtime connection identifier"))
        .action(async (options: StartOptions) => {
            const control = await openMortyControlInstallation(context.shutdownSignal, process.env);
            await ensureDaemon(control.stateDirectory, context.version, context.shutdownSignal);
            const installation = await openMortyCliInstallation(context.shutdownSignal, process.env);
            if (options.connection !== undefined) {
                await installation.setConnectionActivation(options.connection, "active", context.shutdownSignal);
            }
            await reloadDaemon(control.stateDirectory, context.shutdownSignal);
            process.stdout.write("Morty daemon is running.\n");
        });
}
