import type { ComputerDescriptor } from "../../management/entity/pairing.ts";

export class ComputerStatus {
    readonly online: boolean;

    constructor(online: boolean) {
        this.online = online;
    }
}

export class ComputerSummary {
    readonly agents: ComputerDescriptor["agents"];
    readonly computerName: string;
    readonly online: boolean;
    readonly computerId: string;
    readonly workspaceName: string;

    constructor(relay: ComputerDescriptor, status: ComputerStatus) {
        this.agents = relay.agents;
        this.computerId = relay.computerId;
        this.computerName = relay.computerName;
        this.online = status.online;
        this.workspaceName = relay.workspaceName;
    }
}
