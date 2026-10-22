import { createStore } from "zustand/vanilla";
import type { ApiTransport } from "../services/api/api-transport.ts";
import { BotChatApi } from "../services/chat/bot-chat-api.ts";
import { type Clock, systemClock } from "../services/time/clock.ts";
import { type ActiveAnonymousSession, createAnonymousSessionStore } from "./authentication/anonymous-session-store.ts";
import { createContinueStore } from "./authentication/continue-store.ts";
import { createIdentityAccess, type IdentityAccess } from "./authentication/identity-access.ts";
import { createBugReportDialogStore } from "./bug-report-dialog-store.ts";
import { type ChatWorkspace, createChatWorkspace } from "./chat/chat-workspace.ts";
import { createComputerSwitcher } from "./chat/computer-switcher-store.ts";

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

/**
 * The signed-in chat surface, derived from the anonymous session: `active`
 * carries the workspace built for that identity, every other session state
 * carries none. Views subscribe; they never create or release a workspace.
 */
type SessionWorkspaceStoreApi = ReturnType<typeof createSessionWorkspaceStore>;

const createSessionWorkspaceStore = () => createStore<{ workspace: ChatWorkspace | null }>(() => ({ workspace: null }));

export interface MortyApplication {
    readonly clock: Clock;
    readonly anonymousSession: ReturnType<typeof createAnonymousSessionStore>;
    /** The shared bug-report dialog state for every bug-report entry point. */
    readonly bugReportDialog: ReturnType<typeof createBugReportDialogStore>;
    /**
     * The /continue handoff redeem. Created with the application: its store
     * reads the transfer code from the location at creation, and only a real
     * continuation visit starts network work.
     */
    readonly continuation: ReturnType<typeof createContinueStore>;
    /** The signed-in surface; carries the workspace for the active identity. */
    readonly sessionWorkspace: SessionWorkspaceStoreApi;
    readonly identityAccess: (identity: ChatIdentity, onAccessEnded: () => void) => IdentityAccess;
    readonly transport: ApiTransport;
    readonly reloadIdentity: () => void;
    readonly dispose: () => void;
}

/**
 * Owns every application-scoped workflow resource outside React's mount and
 * unmount cycle: the Chat API transport, the anonymous identity session, the
 * shared bug-report dialog, the /continue redeem, and the chat workspace
 * constructed for the active identity. The anonymous identity load starts
 * here with the application lifetime, so no component needs a mount effect
 * to start it, and `dispose` releases everything at once.
 *
 * The workspace lifecycle follows the anonymous session: it is created when
 * the session becomes active for an identity and released when the session
 * leaves it or the application is disposed. Views subscribe to
 * `sessionWorkspace` and render whatever it carries.
 */
export function createMortyApplication(options: {
    readonly origin: string;
    readonly transport: ApiTransport;
    readonly url?: string;
    readonly clock?: Clock;
}): MortyApplication {
    const lifetime = new AbortController();
    const transport = options.transport;
    transport.open();
    const anonymousSession = createAnonymousSessionStore(
        transport.fetch,
        options.origin,
        (session) => {
            // Announced from the session's explicit transitions: the workspace
            // follows the identity without the application subscribing to the
            // session store.
            releaseWorkspace();
            if (session === null) {
                sessionWorkspace.setState({ workspace: null });
                return;
            }
            activateWorkspace(session);
        },
        options.clock ?? systemClock,
    );
    const bugReportDialog = createBugReportDialogStore(() => (disposed ? null : transport));
    const sessionWorkspace = createSessionWorkspaceStore();
    const continuation = createContinueStore(transport.fetch);
    let workspace: ChatWorkspace | null = null;
    let workspaceRequests: BotChatApi | null = null;
    let disposed = false;
    const releaseWorkspace = (): void => {
        workspace?.dispose();
        // The workspace receives the chat API by injection; the application
        // owns it, so it closes the pooled session transports here.
        workspaceRequests?.close();
        workspace = null;
        workspaceRequests = null;
    };
    const activateWorkspace = (session: ActiveAnonymousSession): void => {
        const identity = session.identity;
        const scope: ChatIdentity = {
            botId: identity.botId,
            projectId: identity.projectId,
            getToken: async (signal) => {
                signal.throwIfAborted();
                return identity.token;
            },
        };
        const access = createIdentityAccess({
            fetchRequest: transport.fetch,
            origin: options.origin,
            identity: scope,
            onAccessEnded: () => window.location.reload(),
        });
        const requests = new BotChatApi({
            fetchRequest: transport.fetch,
            getToken: scope.getToken,
            origin: options.origin,
            projectId: identity.projectId,
            subscribe: transport.subscribe,
            waitForChange: transport.waitForChange,
        });
        workspace = createChatWorkspace({
            clock: options.clock ?? systemClock,
            rememberedIdentity: identity,
            accessNotice: session.notice,
            computers: createComputerSwitcher({
                active: identity,
                origin: options.origin,
                fetchRequest: transport.fetch,
                requests: (saved) =>
                    new BotChatApi({
                        fetchRequest: transport.fetch,
                        getToken: async (signal) => {
                            signal.throwIfAborted();
                            return saved.token;
                        },
                        origin: options.origin,
                        projectId: saved.projectId,
                        subscribe: transport.subscribe,
                        waitForChange: transport.waitForChange,
                    }),
            }),
            entry: session.entry,
            botId: identity.botId,
            bugReportDialog,
            projectId: identity.projectId,
            requests,
            url: options.url ?? window.location.href,
            createTransfer: access.createTransfer,
            currentAccessToken: access.currentAccessToken,
            endRemoteAccess: access.endRemoteAccess,
            networkDiagnostics: {
                measureBrowserMobius: transport.measureMobiusLatency,
                measureBrowserMorty: transport.measureMortyLatency,
            },
        });
        workspaceRequests = requests;
        workspace.start();
        sessionWorkspace.setState({ workspace });
    };
    let identityAttempt: AbortController | null = null;
    const reloadIdentity = () => {
        if (disposed) {
            return;
        }
        identityAttempt?.abort(new DOMException("Identity reload replaced", "AbortError"));
        identityAttempt = new AbortController();
        void anonymousSession.getState().load(AbortSignal.any([lifetime.signal, identityAttempt.signal]));
    };
    if (!window.location.pathname.startsWith("/continue")) {
        reloadIdentity();
    }
    return {
        clock: options.clock ?? systemClock,
        anonymousSession,
        bugReportDialog,
        continuation,
        sessionWorkspace,
        identityAccess: (identity, onAccessEnded) =>
            createIdentityAccess({
                fetchRequest: transport.fetch,
                origin: options.origin,
                identity,
                onAccessEnded,
            }),
        transport,
        reloadIdentity,
        dispose: () => {
            if (disposed) {
                return;
            }
            disposed = true;
            lifetime.abort(new DOMException("The Morty application was disposed.", "AbortError"));
            continuation.getState().cancel();
            releaseWorkspace();
            sessionWorkspace.setState({ workspace: null });
            transport.close();
        },
    };
}
