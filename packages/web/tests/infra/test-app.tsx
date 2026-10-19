import { getByTestId, getConfig, queryAllByTestId } from "@testing-library/dom";
import { act, render } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterAll, afterEach } from "vitest";
import { ToastProvider } from "../../src/components/ui/toast.tsx";
import { ApiTransportProvider } from "../../src/services/api/api-transport-context.tsx";
import { WebSocketApiTransport } from "../../src/services/api/websocket-api-transport.ts";
import { App } from "../../src/views/application/app.tsx";
import { Bootstrap } from "../../src/views/application/bootstrap.tsx";
import { router as authenticationRouter } from "../../src/views/authentication/router.tsx";
import { MortyApplication } from "../../src/views/authentication/session-application.tsx";
import { createChatWorkerEnvironment } from "../support/chat-worker.ts";

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Environment = Awaited<ReturnType<typeof createChatWorkerEnvironment>>;
type Application = Awaited<ReturnType<Environment["createApplication"]>>;

const environment = createChatWorkerEnvironment();
const activeApps = new Set<TestApp>();

// Match the longest per-scenario test timeout used by integration tests; the
// surrounding test still fails first through its own vitest timeout.
const VIEW_WAIT_TIMEOUT_MILLISECONDS = 90_000;

export interface TestApp extends Application {
    readonly daemon: Awaited<ReturnType<Application["connectAgent"]>> | null;
    readonly agentFailure: Promise<never> | null;
    readonly close: () => Promise<void>;
    readonly elementByTestId: (testId: string | RegExp, container?: HTMLElement) => HTMLElement;
    readonly elementsByTestId: (testId: string | RegExp) => HTMLElement[];
    readonly optionalElementByTestId: (testId: string | RegExp) => HTMLElement | null;
    readonly remount: () => void;
    readonly openViewer: () => Promise<TestApp>;
    readonly queryElementByTestId: (
        testId: string | RegExp,
        accept?: (element: HTMLElement) => boolean,
    ) => Promise<HTMLElement>;
    readonly waitForView: <T>(read: () => T) => Promise<T>;
    readonly user: UserEvent;
}

export async function createTestApp(
    options: {
        readonly application?: Application;
        readonly connectAgent?: boolean;
        readonly agent?: { readonly id: string; readonly label: string };
        readonly nativeSessionIds?: ReadonlySet<string>;
        readonly page?:
            | { readonly kind: "continue"; readonly harness: string; readonly sessionId: string }
            | { readonly kind: "bootstrap" }
            | { readonly kind: "managed-session"; readonly sessionId: string }
            | { readonly kind: "morty" };
        readonly prepare?: (application: Application) => void | Promise<void>;
    } = {},
): Promise<TestApp> {
    const current = options.application ?? (await (await environment).createApplication());
    await options.prepare?.(current);
    const daemon =
        options.connectAgent === true ? await current.connectAgent(options.agent, options.nativeSessionIds) : null;
    const agentFailure = daemon?.failure ?? null;
    const page = options.page ?? { kind: "morty" };
    if (page.kind === "continue") {
        const transfer = new URL(await current.createTransferUrl());
        transfer.searchParams.set("harness", page.harness);
        transfer.searchParams.set("sessionId", page.sessionId);
        window.location.href = transfer.href;
        authenticationRouter.history.replace(`${transfer.pathname}${transfer.search}${transfer.hash}`);
    } else if (page.kind === "bootstrap") {
        window.location.href = new URL("/", current.origin).href;
    } else if (options.application === undefined) {
        const destination = new URL("/chat", current.origin);
        if (page.kind === "managed-session") {
            destination.searchParams.set("sessionId", page.sessionId);
        }
        window.location.href = destination.href;
    }
    let container = document.createElement("div");
    const mount = () => {
        container.setAttribute("data-test-app-root", "");
        document.body.appendChild(container);
        return render(
            <ApiTransportProvider transport={current.transport}>
                <ToastProvider>
                    {page.kind === "bootstrap" ? (
                        <Bootstrap />
                    ) : page.kind === "continue" ? (
                        <App state={{ kind: "authentication", router: authenticationRouter }} />
                    ) : (
                        <MortyApplication
                            activeIdentity={current.identity}
                            authorize={async (signal) => signal.throwIfAborted()}
                        />
                    )}
                </ToastProvider>
            </ApiTransportProvider>,
            { container },
        );
    };
    let rendered = mount();
    let closed = false;
    const lifetime = new AbortController();
    // Use RTL's async boundary to settle external updates and pending microtasks.
    // DOM observation keeps this wait event-driven rather than polling the network.
    const waitForView = <T,>(read: () => T): Promise<T> =>
        getConfig().asyncWrapper(
            () =>
                new Promise<T>((resolve, reject) => {
                    let lastFailure: unknown;
                    const cleanup = () => {
                        observer.disconnect();
                        clearTimeout(deadline);
                        lifetime.signal.removeEventListener("abort", abort);
                    };
                    const abort = () => {
                        cleanup();
                        reject(lifetime.signal.reason);
                    };
                    const check = () => {
                        try {
                            const result = read();
                            cleanup();
                            resolve(result);
                        } catch (cause) {
                            lastFailure = cause;
                        }
                    };
                    const observer = new MutationObserver(check);
                    // The view wait must honor the test's own timeout budget (each
                    // file sets it per scenario) instead of a fixed wall-clock
                    // deadline that slow CI runners exceed before the test does.
                    const deadline = setTimeout(() => {
                        cleanup();
                        reject(lastFailure ?? new Error("The expected view did not appear."));
                    }, VIEW_WAIT_TIMEOUT_MILLISECONDS);
                    if (lifetime.signal.aborted) {
                        abort();
                        return;
                    }
                    lifetime.signal.addEventListener("abort", abort, { once: true });
                    observer.observe(document.body, {
                        attributes: true,
                        characterData: true,
                        childList: true,
                        subtree: true,
                    });
                    check();
                }),
        );
    const matchingElements = (testId: string | RegExp): HTMLElement[] =>
        queryAllByTestId(document.body, testId).filter(
            (element) => container.contains(element) || element.closest("[data-test-app-root]") === null,
        );
    const optionalElement = (testId: string | RegExp): HTMLElement | null => {
        const matches = matchingElements(testId);
        if (matches.length > 1) {
            throw new Error(`Multiple elements match ${String(testId)}`);
        }
        return matches[0] ?? null;
    };
    const requiredElement = (testId: string | RegExp): HTMLElement => {
        const element = optionalElement(testId);
        if (element === null) {
            throw new Error(`Missing ${String(testId)}; page: ${document.body.textContent}`);
        }
        return element;
    };

    const app: TestApp = {
        ...current,
        agentFailure,
        daemon:
            daemon === null
                ? null
                : {
                      ...daemon,
                      continueReply: async (...args) => {
                          await act(async () => await daemon.continueReply(...args));
                      },
                  },
        openViewer: async () => {
            const transport = new WebSocketApiTransport(current.origin);
            transport.open();
            return await createTestApp({ application: { ...current, transport, close: () => transport.close() } });
        },
        close: async () => {
            if (closed) {
                return;
            }
            closed = true;
            lifetime.abort(new DOMException("The test application closed", "AbortError"));
            rendered.unmount();
            await current.close();
            container.remove();
            activeApps.delete(app);
        },
        elementByTestId: (testId, scope) =>
            scope === undefined ? requiredElement(testId) : getByTestId(scope, testId),
        elementsByTestId: matchingElements,
        optionalElementByTestId: optionalElement,
        remount: () => {
            rendered.unmount();
            container.remove();
            container = document.createElement("div");
            rendered = mount();
        },
        queryElementByTestId: async (testId, accept = () => true) =>
            await waitForView(() => {
                const element = requiredElement(testId);
                if (!accept(element)) {
                    throw new Error(`Element was not ready: ${String(testId)}; page: ${document.body.textContent}`);
                }
                return element;
            }),
        waitForView,
        user: userEvent.setup(),
    };
    activeApps.add(app);
    return app;
}

async function closeTestApps(): Promise<void> {
    await act(async () => {
        await Promise.all([...activeApps].map(async (app) => await app.close()));
    });
}

async function closeTestEnvironment(): Promise<void> {
    await (await environment).close();
}

afterEach(async () => {
    await closeTestApps();
    document.body.replaceChildren();
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/");
});

afterAll(async () => {
    await closeTestEnvironment();
});
