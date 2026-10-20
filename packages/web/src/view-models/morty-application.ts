import type { ApiTransport } from "../services/api/api-transport-context.tsx";
import { BotChatApi } from "../services/chat/bot-chat-api.ts";
import { createAnonymousSessionStore } from "./authentication/anonymous-session-store.ts";
import { type ChatWorkspace, createChatWorkspace } from "./chat/chat-workspace.ts";

/**
 * The scope fields that identify the Bot a chat workspace talks to. The token
 * is read lazily per request, so it is not part of the identity of an
 * instance.
 */
interface ChatIdentity {
    readonly botId: string;
    readonly projectId: string;
    readonly getToken: (signal: AbortSignal) => Promise<string>;
}

export interface MortyApplication {
    readonly anonymousSession: ReturnType<typeof createAnonymousSessionStore>;
    /** The chat workspace for the active identity, created once per identity. */
    readonly chatWorkspace: (identity: ChatIdentity) => ChatWorkspace;
    readonly transport: ApiTransport;
    readonly dispose: () => void;
}

/**
 * Owns every application-scoped workflow resource outside React's mount and
 * unmount cycle: the Chat API transport, the anonymous identity session, and
 * the chat workspace constructed for the active identity. The anonymous
 * identity load starts here with the application lifetime, so no component
 * needs a mount effect to start it, and `dispose` releases everything at once.
 */
export function createMortyApplication(options: {
    readonly origin: string;
    readonly transport: ApiTransport;
}): MortyApplication {
    const lifetime = new AbortController();
    const transport = options.transport;
    transport.open();
    const anonymousSession = createAnonymousSessionStore(transport.fetch, options.origin);
    void anonymousSession.getState().load(lifetime.signal);
    let workspace: ChatWorkspace | null = null;
    let workspaceIdentity: ChatIdentity | null = null;
    return {
        anonymousSession,
        chatWorkspace: (identity) => {
            if (
                workspace !== null &&
                workspaceIdentity?.botId === identity.botId &&
                workspaceIdentity.projectId === identity.projectId
            ) {
                return workspace;
            }
            workspace?.dispose();
            workspace = createChatWorkspace({
                botId: identity.botId,
                requests: new BotChatApi({
                    fetchRequest: transport.fetch,
                    getToken: identity.getToken,
                    origin: options.origin,
                    projectId: identity.projectId,
                    subscribe: transport.subscribe,
                    waitForChange: transport.waitForChange,
                }),
                url: window.location.href,
            });
            workspaceIdentity = identity;
            return workspace;
        },
        transport,
        dispose: () => {
            lifetime.abort(new DOMException("The Morty application was disposed.", "AbortError"));
            workspace?.dispose();
            workspace = null;
            workspaceIdentity = null;
            transport.close();
        },
    };
}
