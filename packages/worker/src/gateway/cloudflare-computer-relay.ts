import type { VerifiedComputerAccess } from "../../../relay-core/src/entity/pairing/pairing.ts";
import type { ComputerRelayGateway } from "../../../relay-core/src/gateway/computer-relay-gateway.ts";
import { requestLogContext } from "../../../relay-core/src/infra/log-diagnostics.ts";
import { logger } from "../../../relay-core/src/infra/logger.ts";
import { ComputerStatus } from "../../../relay-core/src/service/computer-relay/computer.ts";

export class CloudflareComputerRelay implements ComputerRelayGateway {
    readonly #namespace: DurableObjectNamespace;

    readonly #local: ((computerId: string, request: Request) => Promise<Response>) | undefined;

    constructor(
        namespace: DurableObjectNamespace,
        local?: (computerId: string, request: Request) => Promise<Response>,
    ) {
        this.#local = local;
        this.#namespace = namespace;
    }

    readonly acceptDaemon = async (
        access: VerifiedComputerAccess,
        request: Request,
        signal: AbortSignal,
    ): Promise<Response> => {
        const endpoint = new URL(request.url);
        endpoint.pathname = "/daemon";
        return await this.forward(
            access,
            new Request(endpoint, { headers: request.headers, method: request.method, signal }),
            signal,
        );
    };

    readonly refuseRevokedDaemon = (): Response => {
        const pair = new WebSocketPair();
        pair[1].accept();
        pair[1].close(1008, "Computer revoked");
        return new Response(null, { status: 101, webSocket: pair[0] });
    };

    readonly acceptHost = async (
        access: VerifiedComputerAccess,
        request: Request,
        signal: AbortSignal,
    ): Promise<Response> => {
        const headers = new Headers(request.headers);
        const endpoint = new URL(request.url);
        // Public viewers cannot opt into the private request-reply routing mode.
        endpoint.searchParams.delete("nativeRequestId");
        return await this.forward(access, new Request(endpoint, { headers, method: request.method, signal }), signal);
    };

    readonly disconnectComputer = async (access: VerifiedComputerAccess, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        const headers = new Headers();

        const response = await this.fetchComputer(
            access,
            new Request(
                `https://computer-relay.internal/computers/${encodeURIComponent(access.computerId)}/computer/revoke`,
                {
                    headers,
                    method: "DELETE",
                    signal,
                },
            ),
            signal,
        );
        signal.throwIfAborted();
        if (response.status !== 204) {
            throw new Error("The Computer connection could not be revoked");
        }
    };

    readonly readComputerStatus = async (
        access: VerifiedComputerAccess,
        signal: AbortSignal,
    ): Promise<ComputerStatus> => {
        const response = await this.forward(
            access,
            new Request("https://computer-relay.internal/computer-status", {
                method: "GET",
                signal,
            }),
            signal,
        );
        if (!response.ok) {
            throw new Error("The Computer status could not be read");
        }
        const value: unknown = await response.json();
        if (
            typeof value !== "object" ||
            value === null ||
            Array.isArray(value) ||
            typeof Reflect.get(value, "online") !== "boolean"
        ) {
            throw new Error("The Computer returned an invalid status");
        }
        return new ComputerStatus(Reflect.get(value, "online"));
    };

    private readonly forward = async (
        access: VerifiedComputerAccess,
        request: Request,
        signal: AbortSignal,
    ): Promise<Response> => {
        signal.throwIfAborted();
        const headers = new Headers(request.headers);

        const endpoint = new URL(request.url);
        endpoint.pathname = `/computers/${encodeURIComponent(access.computerId)}${endpoint.pathname}`;
        const forwarded = new Request(endpoint, { method: request.method, headers, signal });
        return await this.fetchComputer(access, forwarded, signal);
    };

    private readonly fetchComputer = async (
        access: VerifiedComputerAccess,
        request: Request,
        signal: AbortSignal,
    ): Promise<Response> => {
        const objectId = this.#namespace.idFromName(access.computerId);
        try {
            const response = await (this.#local === undefined
                ? this.#namespace.get(objectId).fetch(request.url, request)
                : this.#local(access.computerId, request));
            signal.throwIfAborted();
            return response;
        } catch (error) {
            logger.error(
                {
                    ...requestLogContext(request),
                    event: "computer_relay_request_failed",
                    durableObjectClass: "ComputerRelay",
                    durableObjectId: objectId.toString(),
                    computerId: access.computerId,
                    err: error,
                },
                "Computer Relay request failed",
            );
            throw error;
        }
    };
}
