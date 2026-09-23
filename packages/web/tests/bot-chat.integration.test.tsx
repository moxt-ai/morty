import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { ToastProvider } from "../src/components/ui/toast.tsx";
import { type ApiTransport, ApiTransportProvider } from "../src/services/api/api-transport-context.tsx";
import { WorkspaceApplication } from "../src/views/authentication/session-application.tsx";

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const botId = "bot_test";
const projectId = "prj_test";

class LocalChatTransport implements ApiTransport {
    readonly #bots = [{ botId, displayName: "My Bot" }];
    #pairingsIssued = 0;
    readonly open = () => {};
    readonly close = () => {};
    readonly fetch = async (request: Request): Promise<Response> => {
        const path = new URL(request.url).pathname;
        if (path.endsWith(`/projects/${projectId}/management/bots`)) {
            if (request.method === "POST") {
                const input: unknown = await request.json();
                if (
                    typeof input !== "object" ||
                    input === null ||
                    !("displayName" in input) ||
                    typeof input.displayName !== "string"
                ) {
                    return Response.json(
                        { error: { code: "INVALID_BOT", message: "Invalid Bot name" } },
                        { status: 400 },
                    );
                }
                const bot = { botId: `bot_${this.#bots.length.toString()}`, displayName: input.displayName };
                this.#bots.push(bot);
                return Response.json(bot, { status: 201 });
            }
            return Response.json({ bots: this.#bots });
        }
        if (path.includes(`/chat/projects/${projectId}/bots/`) && path.endsWith("/workspace")) {
            return Response.json({ status: "draft", runtimeId: null, agents: [] });
        }
        if (path.endsWith(`/projects/${projectId}/identity/pairings`)) {
            this.#pairingsIssued += 1;
            return Response.json({
                url: `http://localhost:3000/pair.md?token=mobius_pair_v2.${this.#pairingsIssued}.${"A".repeat(43)}`,
                expiresAt: "2030-01-01T00:00:00.000Z",
            });
        }
        throw new Error(`Unexpected API request: ${path}`);
    };
    readonly waitForChange = async (request: Request): Promise<void> =>
        await new Promise<void>((_, reject) => {
            request.signal.throwIfAborted();
            request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
        });
}

afterEach(() => {
    document.body.replaceChildren();
    window.history.replaceState(null, "", "/");
});

test("Given an unpaired Bot, when Chat loads, then the user can open its pairing instruction", async () => {
    window.history.replaceState(null, "", "/chat");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const transport = new LocalChatTransport();
    await act(async () => {
        root.render(
            <ApiTransportProvider transport={transport}>
                <ToastProvider>
                    <WorkspaceApplication
                        activeIdentity={{ kind: "anonymous", projectId, getToken: async () => "token" }}
                        authorize={async (signal) => signal.throwIfAborted()}
                        userId="usr_test"
                    />
                </ToastProvider>
            </ApiTransportProvider>,
        );
    });
    const button = await vi.waitFor(() => {
        const found = [...document.querySelectorAll("button")].find((item) => item.textContent === "Pair Agent");
        if (found === undefined) {
            throw new Error(document.body.textContent ?? "Pair Agent is unavailable");
        }
        return found;
    });
    await act(async () => button.click());
    await vi.waitFor(() => {
        const instruction = document.querySelector<HTMLInputElement>('input[aria-label="Agent pairing instruction"]');
        expect(instruction?.value).toMatch(/^follow http:\/\/localhost:3000\/pair\.md/u);
    });
    await act(async () => root.unmount());
});

test("Given a workspace Bot, when the user creates another Bot, then the new Bot becomes the active conversation", async () => {
    window.history.replaceState(null, "", "/chat");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(
            <ApiTransportProvider transport={new LocalChatTransport()}>
                <ToastProvider>
                    <WorkspaceApplication
                        activeIdentity={{ kind: "anonymous", projectId, getToken: async () => "token" }}
                        authorize={async (signal) => signal.throwIfAborted()}
                        userId="usr_test"
                    />
                </ToastProvider>
            </ApiTransportProvider>,
        );
    });
    const name = await vi.waitFor(() => {
        const found = document.querySelector<HTMLInputElement>('input[aria-label="New Bot name"]');
        if (found === null) {
            throw new Error("The Bot name field was not shown");
        }
        return found;
    });
    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(name, "Claude Bot");
        name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const add = [...document.querySelectorAll("button")].find((item) => item.textContent === "Add Bot");
    if (add === undefined) {
        throw new Error("The Add Bot button was not shown");
    }
    await act(async () => add.click());
    await vi.waitFor(() => expect(document.body.textContent).toContain("Claude Bot"));
    await act(async () => root.unmount());
});
