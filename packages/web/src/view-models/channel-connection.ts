import { decodeIdentifier } from "@moxt-ai/mobius-protocol";
import { centralLocalStorage, userChannelEntry } from "@/services/local-storage/central-local-storage";

export interface ChannelReference {
    readonly channelId: string;
}

export type SavedChannel<TConnection> =
    | { readonly kind: "unpaired" }
    | { readonly kind: "connected"; readonly connection: TConnection };

export interface ApplicationConnectionProps<TConnection> {
    readonly view: "overview" | "chat" | "slack";
    readonly userId: string;
    readonly initialConnection: SavedChannel<TConnection>;
}

class ChannelConnectionError extends Error {
    readonly code = "CONNECTION_UNAVAILABLE";
    constructor(options?: ErrorOptions) {
        super("The saved bot connection could not be restored.", options);
        this.name = "ChannelConnectionError";
    }
}

export class BrowserChannelConnection<TConnection extends ChannelReference> {
    readonly #userId: string;
    readonly #readChannel: (channelId: string, signal: AbortSignal) => Promise<TConnection>;
    constructor(userId: string, readChannel: (channelId: string, signal: AbortSignal) => Promise<TConnection>) {
        this.#userId = userId;
        this.#readChannel = readChannel;
    }
    readonly save = (connection: TConnection): void => {
        centralLocalStorage.write(userChannelEntry(this.#userId), decodeIdentifier(connection.channelId));
    };
    readonly load = async (
        requestedChannelId: unknown,
        requestSignal: AbortSignal,
    ): Promise<SavedChannel<TConnection>> => {
        const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(15_000)]);
        try {
            const candidate = requestedChannelId ?? centralLocalStorage.read(userChannelEntry(this.#userId));
            if (candidate === null) {
                return { kind: "unpaired" };
            }
            const channelId = decodeIdentifier(candidate);
            const connection = await this.#readChannel(channelId, signal);
            signal.throwIfAborted();
            if (connection.channelId !== channelId) {
                throw new ChannelConnectionError();
            }
            this.save(connection);
            return { kind: "connected", connection };
        } catch (cause) {
            if (signal.aborted) {
                throw signal.reason;
            }
            if (cause instanceof ChannelConnectionError) {
                throw cause;
            }
            throw new ChannelConnectionError({ cause });
        }
    };
}
