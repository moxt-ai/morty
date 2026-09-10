import { RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import {
    type ApplicationConnectionProps,
    BrowserChannelConnection,
    type ChatApplicationProps,
    createApplicationRouter,
    MobiusApplications,
    type ProjectApplicationProps,
} from "../../packages/web/src/cloud/index.ts";

interface TestConnection {
    readonly channelId: string;
}
const connection = { channelId: "channel-1" };

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-10T00:00:00Z"));
    window.history.replaceState(null, "", "/");
    window.localStorage.clear();
});
afterEach(() => vi.useRealTimers());

function Projects({ onChannelSelected, userId }: ProjectApplicationProps) {
    return (
        <button type="button" onClick={() => onChannelSelected(connection.channelId)}>
            Use my bot as {userId}
        </button>
    );
}
function Chat({ connection: selected }: ChatApplicationProps<TestConnection>) {
    return <p>Chat is ready for {selected.channelId}.</p>;
}
function Slack({ userId }: { readonly userId: string }) {
    return <p>Slack integration is ready for {userId}.</p>;
}
function Content(props: ApplicationConnectionProps<TestConnection>) {
    return (
        <MobiusApplications {...props} ChatApplication={Chat} SlackApplication={Slack} ProjectsApplication={Projects} />
    );
}
async function renderApplication() {
    const router = createApplicationRouter(
        async (signal) => signal.throwIfAborted(),
        "user_alice",
        Content,
        new BrowserChannelConnection("user_alice", window.localStorage, async (channelId, signal) => {
            signal.throwIfAborted();
            if (channelId !== connection.channelId) {
                throw new Error("Unknown bot channel");
            }
            return connection;
        }),
        { Standard: ({ children }) => <main>{children}</main>, Application: ({ children }) => <main>{children}</main> },
    );
    return render(<RouterProvider router={router} />);
}

test("Given an authenticated user, When they select an owned bot, Then they can open Chat and Slack without a workspace", async () => {
    const screen = await renderApplication();
    await screen.getByRole("button", { name: "Use my bot as user_alice" }).click();
    await screen.getByRole("link", { name: "Open Chat" }).click();
    await expect.element(screen.getByText("Chat is ready for channel-1.")).toBeVisible();
    window.history.back();
    await expect.element(screen.getByRole("button", { name: "Use my bot as user_alice" })).toBeVisible();
    await screen.getByRole("link", { name: "Open Slack" }).click();
    await expect.element(screen.getByText("Slack integration is ready for user_alice.")).toBeVisible();
});
