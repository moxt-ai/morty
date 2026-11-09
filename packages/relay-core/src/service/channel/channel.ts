import type { ChannelDescriptor } from "../../entity/pairing/pairing.ts";

export class RuntimeStatus {
    readonly online: boolean;

    constructor(online: boolean) {
        this.online = online;
    }
}

export class RuntimeDescriptor {
    readonly agents: ChannelDescriptor["agents"];
    readonly channelId: string;
    readonly machineName: string;
    readonly online: boolean;
    readonly computerId: string;
    readonly pairingId: string;
    readonly workspaceName: string;

    constructor(channel: ChannelDescriptor, status: RuntimeStatus) {
        this.agents = channel.agents;
        this.channelId = channel.channelId;
        this.machineName = channel.machineName;
        this.online = status.online;
        this.computerId = channel.computerId;
        this.pairingId = channel.pairingId;
        this.workspaceName = channel.workspaceName;
    }
}
