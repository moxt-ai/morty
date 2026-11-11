import type { ChannelDescriptor } from "../../entity/pairing/pairing.ts";

export class ComputerStatus {
    readonly online: boolean;

    constructor(online: boolean) {
        this.online = online;
    }
}

export class ComputerDescriptor {
    readonly agents: ChannelDescriptor["agents"];
    readonly machineName: string;
    readonly online: boolean;
    readonly computerId: string;
    readonly workspaceName: string;

    constructor(channel: ChannelDescriptor, status: ComputerStatus) {
        this.agents = channel.agents;
        this.computerId = channel.computerId;
        this.machineName = channel.machineName;
        this.online = status.online;
        this.workspaceName = channel.workspaceName;
    }
}
