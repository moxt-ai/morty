import { isIdentifier, type NativeSessionTarget } from "@morty-build/client/protocol";
import { MortyValidationError } from "../errors.ts";
import { nativeSessionTargetSchema } from "../protocol/session/shared/native-session-target.ts";

export interface MortyEndpointCall {
    readonly computerId: string;
    readonly method: "GET" | "POST" | "PUT" | "DELETE";
    readonly scope: "session" | "computer";
    readonly path: string;
    readonly transport: "http" | "websocket";
}

function endpoint(
    method: MortyEndpointCall["method"],
    resource: string,
    transport: MortyEndpointCall["transport"] = "websocket",
) {
    return (computerId: string, target: NativeSessionTarget, query = new URLSearchParams()): MortyEndpointCall => {
        if (!isIdentifier(computerId)) {
            throw new MortyValidationError("The Morty Computer identifier is invalid");
        }
        const parsed = nativeSessionTargetSchema.safeParse(target);
        if (!parsed.success) {
            throw new MortyValidationError("The harness and native Session identity are invalid", {
                cause: parsed.error,
            });
        }
        const suffix = query.size === 0 ? "" : `?${query.toString()}`;
        return {
            computerId,
            scope: "session",
            method,
            path: `v1/computers/${encodeURIComponent(computerId)}/harnesses/${encodeURIComponent(parsed.data.harness)}/sessions/${encodeURIComponent(parsed.data.sessionId)}/${resource}${suffix}`,
            transport,
        };
    };
}

export const sessionEndpoints = Object.freeze({
    readConfiguration: endpoint("GET", "configuration"),
    updateConfiguration: endpoint("POST", "configuration"),
    rename: endpoint("POST", "rename"),
    readFile: endpoint("GET", "files/content", "http"),
    readExecution: endpoint("GET", "active-turn"),
    submitTurn: endpoint("POST", "turns"),
    events: endpoint("GET", "events-v2"),
    uploadContent: (key: string) => endpoint("PUT", `content/${encodeURIComponent(key)}`),
    cancelTurn: (turnId: string) => endpoint("POST", `turns/${encodeURIComponent(turnId)}/cancel`),
    cancelQueuedTurn: (turnId: string) => endpoint("POST", `turns/${encodeURIComponent(turnId)}/cancel-before-start`),
    steerTurn: (turnId: string) => endpoint("PUT", `turns/${encodeURIComponent(turnId)}/disposition`),
    respond: (interactionId: string) => endpoint("POST", `interactions/${encodeURIComponent(interactionId)}/responses`),
});
