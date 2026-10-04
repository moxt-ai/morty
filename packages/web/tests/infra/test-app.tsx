import { getByTestId, queryAllByTestId } from "@testing-library/dom";
import { render } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { ToastProvider } from "../../src/components/ui/toast.tsx";
import { ApiTransportProvider } from "../../src/services/api/api-transport-context.tsx";
import { WebSocketApiTransport } from "../../src/services/api/websocket-api-transport.ts";
import { App } from "../../src/views/application/app.tsx";
import { router as authenticationRouter } from "../../src/views/authentication/router.tsx";
import { WorkspaceApplication } from "../../src/views/authentication/session-application.tsx";
import { createChatWorkerEnvironment } from "../support/chat-worker.ts";

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Environment = Awaited<ReturnType<typeof createChatWorkerEnvironment>>;
type Application = Awaited<ReturnType<Environment["createApplication"]>>;

const environment = createChatWorkerEnvironment();
const activeApps = new Set<TestApp>();

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
        readonly page?:
            | { readonly kind: "continue"; readonly harness: string; readonly sessionId: string }
            | { readonly kind: "workspace" };
        readonly prepare?: (application: Application) => void | Promise<void>;
    } = {},
): Promise<TestApp> {
    const current = options.application ?? (await (await environment).createApplication());
    await options.prepare?.(current);
    const daemon = options.connectAgent === true ? await current.connectAgent() : null;
    const agentFailure = daemon?.failure ?? null;
    const page = options.page ?? { kind: "workspace" };
    if (page.kind === "continue") {
        const transfer = new URL(await current.createTransferUrl());
        transfer.searchParams.set("harness", page.harness);
        transfer.searchParams.set("sessionId", page.sessionId);
        window.location.href = transfer.href;
        authenticationRouter.history.replace(`${transfer.pathname}${transfer.search}${transfer.hash}`);
    } else if (options.application === undefined) {
        window.location.href = `${current.origin}/chat`;
    }
    let container = document.createElement("div");
    const mount = () => {
        container.setAttribute("data-test-app-root", "");
        document.body.appendChild(container);
        return render(
            <ApiTransportProvider transport={current.transport}>
                <ToastProvider>
                    {page.kind === "continue" ? (
                        <App state={{ kind: "authentication", router: authenticationRouter }} />
                    ) : (
                        <WorkspaceApplication
                            activeIdentity={current.identity}
                            authorize={async (signal) => signal.throwIfAborted()}
                            userId={current.userId}
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
    const waitForView = <T,>(read: () => T): Promise<T> =>
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
            const deadline = setTimeout(() => {
                cleanup();
                reject(lastFailure ?? new Error("The expected view did not appear."));
            }, 12_000);
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
        });
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
        daemon,
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

export async function closeTestApps(): Promise<void> {
    await Promise.all([...activeApps].map(async (app) => await app.close()));
}

export async function closeTestEnvironment(): Promise<void> {
    await (await environment).close();
}
