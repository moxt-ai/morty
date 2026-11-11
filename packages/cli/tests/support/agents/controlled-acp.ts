import { ControlledAcpSpecification } from "./controlled-acp-specification.ts";

const CONTROLLED_ACP_VERSION = "1.0.0";

export class ControlledAcpAgentSpecification extends ControlledAcpSpecification {
    readonly agentExecutable = "controlled-acp";
    readonly harness = "controlled-acp";
    readonly label = "Controlled ACP";
    override readonly minimumSupportedAgentVersion = CONTROLLED_ACP_VERSION;

    constructor() {
        super("MORTY_TEST_CONTROLLED_ACP_PATH", []);
    }
}
