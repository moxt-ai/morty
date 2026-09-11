import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ManagementApi } from "../../src/services/management/management-api.ts";
import { PlatformProjectSetup } from "../../src/views/applications/platform-project-setup.tsx";

// The stateful Cloud peer owns the mapping; hosted Clerk login is verified manually.
class ProjectCloud {
    #project: { readonly projectId: string; readonly displayName: string } | null = null;
    readonly fetch = async (request: Request) => {
        request.signal.throwIfAborted();
        if (request.headers.get("authorization") !== "Bearer session") {
            return Response.json({ error: { code: "UNAUTHENTICATED", message: "Sign in." } }, { status: 401 });
        }
        if (request.method === "POST") {
            if (request.headers.get("x-mobius-developer-token") !== "developer") {
                return Response.json(
                    { error: { code: "PLATFORM_DEVELOPER_REQUIRED", message: "Developer access required." } },
                    { status: 403 },
                );
            }
            const value: unknown = await request.json();
            if (
                typeof value !== "object" ||
                value === null ||
                !("displayName" in value) ||
                typeof value.displayName !== "string"
            ) {
                throw new Error("Invalid Project request");
            }
            this.#project ??= { projectId: "project-test", displayName: value.displayName };
        }
        return Response.json({ project: this.#project });
    };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-11T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

test("Given a signed-in Platform developer, When they create a Project and reopen setup, Then the saved Project name is shown", async () => {
    const cloud = new ProjectCloud();
    const api = new ManagementApi({
        origin: window.location.origin,
        fetchRequest: cloud.fetch,
        getToken: async (signal) => {
            signal.throwIfAborted();
            return "session";
        },
    });
    const getPlatformToken = async (signal: AbortSignal) => {
        signal.throwIfAborted();
        return "developer";
    };
    const screen = await render(<PlatformProjectSetup requests={api} getPlatformToken={getPlatformToken} />);
    await screen.getByRole("textbox", { name: "Project name" }).fill("My agent workspace");
    await screen.getByRole("button", { name: "Create Platform Project" }).click();
    await expect.element(screen.getByText("My agent workspace")).toBeVisible();
    await screen.unmount();
    const reopened = await render(<PlatformProjectSetup requests={api} getPlatformToken={getPlatformToken} />);
    await expect.element(reopened.getByText("My agent workspace")).toBeVisible();
    await expect.element(reopened.getByRole("button", { name: "Create Platform Project" })).not.toBeInTheDocument();
});
