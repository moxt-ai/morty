import { decodeSessionReadyEvent, type SessionConfigurationSelection } from "@morty-build/client/protocol";
import { HttpApiTransport } from "../../packages/web/src/services/api/http-api-transport.ts";
import { BotChatApi } from "../../packages/web/src/services/chat/bot-chat-api.ts";

/** Uses the product's owner API client against the real Worker in Runtime integration scenarios. */
export function createOwnerApi(options: {
    readonly origin: string;
    readonly computerId: string;
    readonly credential: string;
    readonly request: (request: Request) => Promise<Response>;
}) {
    const transport = new HttpApiTransport(options.origin);
    const api = new BotChatApi({
        origin: options.origin,
        computerId: options.computerId,
        fetchRequest: options.request,
        getToken: async (signal) => {
            signal.throwIfAborted();
            return options.credential;
        },
        waitForChange: transport.waitForChange,
    });
    return {
        api,
        createSession: async (
            input: {
                readonly harness: string;
                readonly configurations: readonly SessionConfigurationSelection[];
                readonly directory: string;
                readonly computerId: string;
                readonly operationId: string;
            },
            signal: AbortSignal,
        ) => {
            const setup = await options.request(
                new Request(`${options.origin}/morty/api/chat/computers/${options.computerId}/setup`, {
                    method: "POST",
                    signal,
                    headers: { authorization: `Bearer ${options.credential}`, "content-type": "application/json" },
                    body: JSON.stringify({ computerId: options.computerId, harness: input.harness }),
                }),
            );
            if (setup.status !== 202) {
                throw new Error(`Runtime setup failed (${setup.status}): ${await setup.text()}`);
            }
            const access = await api.createConversation(
                input.operationId,
                {
                    harness: input.harness,
                    workspaceRef: input.directory,
                    workspaceLabel: input.directory,
                    configurations: input.configurations,
                },
                signal,
            );
            return decodeSessionReadyEvent(JSON.stringify(access.ready));
        },
        sessionClient: api.connectSession,
        close: () => {
            api.close();
            transport.dispose();
        },
    };
}
