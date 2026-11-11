import type { ComputerDescriptor } from "../../entity/pairing/pairing.ts";

export class ComputerOnlineStatus {
    readonly online: boolean;

    constructor(online: boolean) {
        this.online = online;
    }
}

export class ConnectedComputer {
    readonly agents: ComputerDescriptor["agents"];
    readonly machineName: string;
    readonly online: boolean;
    readonly computerId: string;
    readonly workspaceName: string;

    constructor(computer: ComputerDescriptor, status: ComputerOnlineStatus) {
        this.agents = computer.agents;
        this.computerId = computer.computerId;
        this.machineName = computer.machineName;
        this.online = status.online;
        this.workspaceName = computer.workspaceName;
    }
}
