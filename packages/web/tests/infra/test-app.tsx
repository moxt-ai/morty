import { getAllByTestId, getByTestId, queryByTestId } from "@testing-library/dom";
import { render } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { vi } from "vitest";
import { ToastProvider } from "../../src/components/ui/toast.tsx";
import { ApiTransportProvider } from "../../src/services/api/api-transport-context.tsx";
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
    readonly agentFailure: Promise<never> | null;
    readonly close: () => Promise<void>;
    readonly elementByTestId: (testId: string | RegExp, container?: HTMLElement) => HTMLElement;
    readonly elementsByTestId: (testId: string | RegExp) => HTMLElement[];
    readonly optionalElementByTestId: (testId: string | RegExp) => HTMLElement | null;
    readonly reload: () => void;
    readonly queryElementByTestId: (
        testId: string | RegExp,
        accept?: (element: HTMLElement) => boolean,
    ) => Promise<HTMLElement>;
    readonly user: UserEvent;
}

export async function createTestApp(
    options: {
        readonly agentBehavior?: Parameters<Application["connectAgent"]>[0];
        readonly connectAgent?: boolean;
        readonly page?:
            | { readonly kind: "continue"; readonly harness: string; readonly sessionId: string }
            | { readonly kind: "workspace" };
        readonly prepare?: (application: Application) => void | Promise<void>;
    } = {},
): Promise<TestApp> {
    const current = await (await environment).createApplication();
    await options.prepare?.(current);
    const agentFailure =
        options.connectAgent === true ? (await current.connectAgent(options.agentBehavior)).failure : null;
    const page = options.page ?? { kind: "workspace" };
    if (page.kind === "continue") {
        const transfer = new URL(await current.createTransferUrl());
        transfer.searchParams.set("harness", page.harness);
        transfer.searchParams.set("sessionId", page.sessionId);
        window.location.href = transfer.href;
        authenticationRouter.history.replace(`${transfer.pathname}${transfer.search}${transfer.hash}`);
    } else {
        window.location.href = `${current.origin}/chat`;
    }
    let container = document.createElement("div");
    const mount = () => {
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
    const app: TestApp = {
        ...current,
        agentFailure,
        close: async () => {
            if (closed) {
                return;
            }
            closed = true;
            rendered.unmount();
            await current.close();
            container.remove();
            activeApps.delete(app);
        },
        elementByTestId: (testId, scope = document.body) => getByTestId(scope, testId),
        elementsByTestId: (testId) => getAllByTestId(document.body, testId),
        optionalElementByTestId: (testId) => queryByTestId(document.body, testId),
        reload: () => {
            rendered.unmount();
            container.remove();
            container = document.createElement("div");
            rendered = mount();
        },
        queryElementByTestId: async (testId, accept = () => true) =>
            await vi.waitFor(
                () => {
                    const element = getByTestId(document.body, testId);
                    if (!accept(element)) {
                        throw new Error(`Element was not ready: ${String(testId)}; page: ${document.body.textContent}`);
                    }
                    return element;
                },
                { timeout: 12_000 },
            ),
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
