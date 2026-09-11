import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ManagementApi } from "../../src/services/management/management-api.ts";
import { PlatformProjectSetup } from "../../src/views/applications/platform-project-setup.tsx";

// Stateful Cloud peer: live Platform credentials are not needed for browser acceptance.
class ProjectCloud {
    #project: { readonly projectId: string; readonly displayName: string } | null = null;
    readonly fetch = async (request: Request) => {
        request.signal.throwIfAborted();
        if (request.headers.get("authorization") !== "Bearer session") {
            return Response.json({ error: { code: "UNAUTHENTICATED", message: "Sign in." } }, { status: 401 });
        }
        if (request.method === "POST") {
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

test("Given an anonymous user, When they create a Project and reopen setup, Then the saved Project name is shown without account binding", async () => {
    const cloud = new ProjectCloud();
    const api = new ManagementApi({
        origin: window.location.origin,
        fetchRequest: cloud.fetch,
        getToken: async (signal) => {
            signal.throwIfAborted();
            return "session";
        },
    });
    const screen = await render(<PlatformProjectSetup requests={api} />);
    await screen.getByRole("textbox", { name: "Project name" }).fill("My agent workspace");
    await screen.getByRole("button", { name: "Create Platform Project" }).click();
    await expect.element(screen.getByText("My agent workspace")).toBeVisible();
    await screen.unmount();
    const reopened = await render(<PlatformProjectSetup requests={api} />);
    await expect.element(reopened.getByText("My agent workspace")).toBeVisible();
    await expect.element(reopened.getByRole("button", { name: "Create Platform Project" })).not.toBeInTheDocument();
});
