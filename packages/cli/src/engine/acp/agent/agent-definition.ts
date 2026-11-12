import type { SessionCapabilities } from "@morty-build/client/protocol";
import type { ExecutableIdentity } from "../../util/process/executable.ts";
import { readExecutableIdentity } from "../../util/process/local-executable.ts";
import { unsupportedSessionCapabilities } from "../protocol/session-capabilities.ts";

/** A verified local Agent. Its adapter owns how connections are established. */
export class AcpAgentDefinition {
    readonly agentIdentity: ExecutableIdentity;
    readonly agentVersion: string;
    readonly capabilities: SessionCapabilities;
    readonly command: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly harness: string;
    readonly label: string;

    constructor(
        harness: string,
        label: string,
        command: string,
        environment: Readonly<Record<string, string>> = {},
        agentVersion = "",
        agentIdentity: ExecutableIdentity = readExecutableIdentity(command),
        capabilities: SessionCapabilities = unsupportedSessionCapabilities(),
    ) {
        this.agentIdentity = agentIdentity;
        this.agentVersion = agentVersion;
        this.capabilities = Object.freeze({ ...capabilities });
        this.command = agentIdentity.realPath;
        this.environment = Object.freeze({ ...environment });
        this.harness = harness;
        this.label = label;
    }

    readonly withEnvironment = (environment: Readonly<Record<string, string>>): AcpAgentDefinition =>
        new AcpAgentDefinition(
            this.harness,
            this.label,
            this.command,
            environment,
            this.agentVersion,
            this.agentIdentity,
            this.capabilities,
        );
}
