import type { ApiEndpoint } from "./api-transport.ts";

const chatOperations = Object.freeze({
    "daemon-diagnostics": "none",
    "network-diagnostic": "none",
    access: "none",
    "managed-sessions": "none",
    "managed-session/archive": "none",
    "managed-session": "none",
    "continue-native-session": "none",
    "agent-settings": "none",
    workspace: "snapshot",
    "workspace/directory": "none",
    "native-sessions": "none",
    "native-session": "none",
    "session-access": "none",
});

export type ChatOperation = keyof typeof chatOperations | `native-session-forks/${string}` | `native-session/${string}`;

export function chatEndpoint(origin: string, computerId: string, operation: ChatOperation): ApiEndpoint {
    return {
        target: { kind: "computer", computerId },
        url: new URL(`/morty/api/chat/computers/${encodeURIComponent(computerId)}/${operation}`, origin),
        method: "POST",
        operation,
        watch: operation === "workspace" ? "snapshot" : "none",
    };
}

export function managementEndpoint(
    origin: string,
    computerId: string,
    resource: "/computer" | "/computer/pairing-state",
): ApiEndpoint {
    return {
        target: { kind: "computer", computerId },
        url: new URL(`/morty/api/computers/${encodeURIComponent(computerId)}/management${resource}`, origin),
        method: "GET",
        operation: resource === "/computer" ? "computer" : "pairing-state",
        watch: resource === "/computer" ? "none" : "snapshot",
    };
}

export type IdentityOperation =
    | "/session"
    | "/identity/transfers"
    | "/identity/transfers/redeem"
    | "/identity/devices"
    | "/identity/v1/other-browser-access"
    | "/identity/v1/local-credential"
    | "/identity/v1/browser-access"
    | `/identity/v1/devices/${string}`;

export function identityEndpoint(origin: string, computerId: string | null, operation: IdentityOperation): ApiEndpoint {
    const path =
        computerId !== null && operation !== "/identity/transfers/redeem"
            ? `/computers/${encodeURIComponent(computerId)}${operation}`
            : operation;
    const method =
        operation === "/identity/transfers" || operation === "/identity/transfers/redeem"
            ? "POST"
            : operation.startsWith("/identity/v1/")
              ? "DELETE"
              : "GET";
    return {
        target:
            computerId === null || operation === "/identity/transfers/redeem"
                ? { kind: "worker" }
                : { kind: "computer", computerId },
        url: new URL(`/morty/api${path}`, origin),
        method,
        operation,
        watch: operation === "/identity/devices" ? "snapshot" : "none",
    };
}
