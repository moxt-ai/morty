import type { ComputerDescriptor } from "../../entity/pairing/pairing.ts";

export class ComputerStatus {
    readonly online: boolean;

    constructor(online: boolean) {
        this.online = online;
    }
}

export class ComputerSummary {
    readonly agents: ComputerDescriptor["agents"];
    readonly machineName: string;
    readonly online: boolean;
    readonly computerId: string;
    readonly workspaceName: string;

    constructor(relay: ComputerDescriptor, status: ComputerStatus) {
        this.agents = relay.agents;
        this.computerId = relay.computerId;
        this.machineName = relay.machineName;
        this.online = status.online;
        this.workspaceName = relay.workspaceName;
    }
}
