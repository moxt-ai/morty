import type { Command } from "commander";
import { readLocalAgentInventory } from "../../../daemon/agents/local-agent-inventory.ts";
import type { CliContext } from "../../context.ts";
import { formatAgentDiagnostics } from "./logic/agent-diagnostics.ts";

interface AgentOptions {
    readonly json?: boolean;
    readonly verbose?: boolean;
}

export function registerAgentsHandler(program: Command, context: CliContext): void {
    program
        .command("agents")
        .description("show detected, missing, and integration-ready Agents")
        .option("--json", "write the Agent inventory as JSON")
        .option("--verbose", "include per-Agent detection timing")
        .action(async (options: AgentOptions) => {
            const inventory = await readLocalAgentInventory(process.env, context.shutdownSignal);
            process.stdout.write(formatAgentDiagnostics(inventory, options.json === true, options.verbose === true));
        });
}
