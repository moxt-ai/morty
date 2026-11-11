import { assertKind, parseJson, readBoolean, readIdentifier } from "../shared/message-codec.ts";

export const COMPUTER_STATUS_KIND = "computer.status";
export const COMPUTER_LIVENESS_READY_KIND = "computer.liveness.ready";
export const COMPUTER_HEARTBEAT_KIND = "computer.heartbeat";
export const COMPUTER_HEARTBEAT_ACK_KIND = "computer.heartbeat.ack";
export const COMPUTER_PING_KIND = "computer.ping";
export const COMPUTER_PONG_KIND = "computer.pong";

/**
 * The Relay's host answers this exact text without waking the Relay, so a heartbeat and its
 * acknowledgement carry no per-heartbeat data and must keep this byte-for-byte encoding.
 */
export const COMPUTER_HEARTBEAT_MESSAGE = `{"kind":"${COMPUTER_HEARTBEAT_KIND}"}`;
export const COMPUTER_HEARTBEAT_ACK_MESSAGE = `{"kind":"${COMPUTER_HEARTBEAT_ACK_KIND}"}`;

export interface ComputerStatusEvent {
    readonly kind: typeof COMPUTER_STATUS_KIND;
    readonly online: boolean;
    readonly computerId: string;
}

export interface ComputerLivenessReadyEvent {
    readonly kind: typeof COMPUTER_LIVENESS_READY_KIND;
}

export interface ComputerHeartbeatEvent {
    readonly kind: typeof COMPUTER_HEARTBEAT_KIND;
}

export interface ComputerHeartbeatAckEvent {
    readonly kind: typeof COMPUTER_HEARTBEAT_ACK_KIND;
}

export interface ComputerPingCommand {
    readonly kind: typeof COMPUTER_PING_KIND;
    readonly requestId: string;
}

export interface ComputerPongEvent {
    readonly kind: typeof COMPUTER_PONG_KIND;
    readonly requestId: string;
}

export function decodeComputerStatusEvent(encoded: string): ComputerStatusEvent {
    const value = parseJson(encoded);
    assertKind(value, COMPUTER_STATUS_KIND);

    return {
        kind: COMPUTER_STATUS_KIND,
        online: readBoolean(value, "online"),
        computerId: readIdentifier(value, "computerId"),
    };
}

export function decodeComputerLivenessReadyEvent(encoded: string): ComputerLivenessReadyEvent {
    const value = parseJson(encoded);
    assertKind(value, COMPUTER_LIVENESS_READY_KIND);
    return { kind: COMPUTER_LIVENESS_READY_KIND };
}

export function decodeComputerHeartbeatEvent(encoded: string): ComputerHeartbeatEvent {
    const value = parseJson(encoded);
    assertKind(value, COMPUTER_HEARTBEAT_KIND);
    return { kind: COMPUTER_HEARTBEAT_KIND };
}

export function decodeComputerHeartbeatAckEvent(encoded: string): ComputerHeartbeatAckEvent {
    const value = parseJson(encoded);
    assertKind(value, COMPUTER_HEARTBEAT_ACK_KIND);
    return { kind: COMPUTER_HEARTBEAT_ACK_KIND };
}

export function decodeComputerPingCommand(encoded: string): ComputerPingCommand {
    const value = parseJson(encoded);
    assertKind(value, COMPUTER_PING_KIND);
    return { kind: COMPUTER_PING_KIND, requestId: readIdentifier(value, "requestId") };
}

export function decodeComputerPongEvent(encoded: string): ComputerPongEvent {
    const value = parseJson(encoded);
    assertKind(value, COMPUTER_PONG_KIND);
    return { kind: COMPUTER_PONG_KIND, requestId: readIdentifier(value, "requestId") };
}

export function encodeComputerStatusEvent(message: ComputerStatusEvent): string {
    return JSON.stringify(decodeComputerStatusEvent(JSON.stringify(message)));
}

export function encodeComputerLivenessReadyEvent(message: ComputerLivenessReadyEvent): string {
    return JSON.stringify(decodeComputerLivenessReadyEvent(JSON.stringify(message)));
}

export function encodeComputerHeartbeatEvent(message: ComputerHeartbeatEvent): string {
    decodeComputerHeartbeatEvent(JSON.stringify(message));
    return COMPUTER_HEARTBEAT_MESSAGE;
}

export function encodeComputerHeartbeatAckEvent(message: ComputerHeartbeatAckEvent): string {
    decodeComputerHeartbeatAckEvent(JSON.stringify(message));
    return COMPUTER_HEARTBEAT_ACK_MESSAGE;
}

export function encodeComputerPingCommand(message: ComputerPingCommand): string {
    return JSON.stringify(decodeComputerPingCommand(JSON.stringify(message)));
}

export function encodeComputerPongEvent(message: ComputerPongEvent): string {
    return JSON.stringify(decodeComputerPongEvent(JSON.stringify(message)));
}
