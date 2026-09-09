import * as v from "valibot";
import { workspaceIdSchema } from "./contracts.ts";

export interface WorkspaceChannel {
    readonly channelId: string;
}

export type WorkspaceConnection<TConnection> =
    | { readonly kind: "unpaired" }
    | { readonly kind: "connected"; readonly connection: TConnection };

export interface WorkspaceConnectionProps<TConnection> {
    readonly initialConnection: WorkspaceConnection<TConnection>;
}

export class WorkspaceConnectionError extends Error {
    readonly code = "CONNECTION_UNAVAILABLE";

    constructor(options?: ErrorOptions) {
        super("The saved machine connection could not be restored.", options);
        this.name = "WorkspaceConnectionError";
    }
}

const channelIdSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u));

// Store only a channel reference. The channel service owns credentials and
// reauthorizes access whenever a workspace is opened, including after reload.
export class BrowserWorkspaceConnections<TConnection extends WorkspaceChannel> {
    readonly #userId: string;
    readonly #storage: Storage;
    readonly #readChannel: (channelId: string, signal: AbortSignal) => Promise<TConnection>;

    constructor(
        userId: string,
        storage: Storage,
        readChannel: (channelId: string, signal: AbortSignal) => Promise<TConnection>,
    ) {
        this.#userId = userId;
        this.#storage = storage;
        this.#readChannel = readChannel;
    }

    readonly #key = (workspaceId: string): string =>
        `mobius-cloud:workspace-channel:${encodeURIComponent(this.#userId)}:${v.parse(workspaceIdSchema, workspaceId)}`;

    readonly save = (workspaceId: string, connection: TConnection): void => {
        try {
            this.#storage.setItem(this.#key(workspaceId), v.parse(channelIdSchema, connection.channelId));
        } catch (cause) {
            throw new WorkspaceConnectionError({ cause });
        }
    };

    readonly load = async (
        workspaceId: string,
        requestedChannelId: unknown,
        requestSignal: AbortSignal,
    ): Promise<WorkspaceConnection<TConnection>> => {
        const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(15_000)]);
        try {
            signal.throwIfAborted();
            const candidate = requestedChannelId ?? this.#storage.getItem(this.#key(workspaceId));
            if (candidate === null) {
                return { kind: "unpaired" };
            }
            const channelId = v.parse(channelIdSchema, candidate);
            const connection = await this.#readChannel(channelId, signal);
            signal.throwIfAborted();
            if (connection.channelId !== channelId) {
                throw new WorkspaceConnectionError();
            }
            this.save(workspaceId, connection);
            return { kind: "connected", connection };
        } catch (cause) {
            if (signal.aborted) {
                throw signal.reason;
            }
            if (cause instanceof WorkspaceConnectionError) {
                throw cause;
            }
            throw new WorkspaceConnectionError({ cause });
        }
    };
}
