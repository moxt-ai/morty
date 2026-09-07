import { type BrowserClerk, ClerkProvider } from "@clerk/react";
import { loadClerkJSScript } from "@clerk/shared/loadClerkJsScript";
import { createRoot } from "react-dom/client";
import { publicConfigSchema, sessionSchema } from "../shared/contracts.ts";
import { App, type AppState, Page } from "./App.tsx";
import { clerkDirectory, waitForClerk } from "./workspaces/clerk-directory.ts";
import { WorkspaceError } from "./workspaces/contracts.ts";
import { MobiusManagement } from "./workspaces/MobiusManagement.tsx";
import { createWorkspaceRouter } from "./workspaces/router.tsx";
import "./style.css";

declare global {
  var Clerk: BrowserClerk | undefined;
}

const element = document.getElementById("root");
if (!element) throw new Error("Missing application root.");
const root = createRoot(element);
const lifetime = new AbortController();
window.addEventListener("pagehide", () => lifetime.abort(), { once: true });
window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});
root.render(
  <Page>
    <p role="status">Loading Mobius Cloud…</p>
  </Page>,
);

async function start() {
  const signal = AbortSignal.any([
    lifetime.signal,
    AbortSignal.timeout(20_000),
  ]);
  const response = await fetch("/api/config", { signal });
  if (!response.ok) throw new Error("Sign-in configuration is unavailable.");
  const body: unknown = await response.json();
  const { publishableKey } = publicConfigSchema.parse(body);
  await waitForClerk(() => loadClerkJSScript({ publishableKey }), signal);
  const clerk = globalThis.Clerk;
  if (!clerk) throw new Error("Sign-in could not be initialized.");
  let state: AppState = { kind: "loading" };
  const render = () =>
    root.render(
      <ClerkProvider
        publishableKey={publishableKey}
        signInFallbackRedirectUrl="/"
        signUpFallbackRedirectUrl="/"
      >
        <App state={state} />
      </ClerkProvider>,
    );
  render();

  function disposeRouter() {
    if (state.kind === "signed-in") state.router.dispose();
  }
  const unsubscribe = clerk.addListener(({ session }) => {
    if (lifetime.signal.aborted || session === undefined) return;
    signal.removeEventListener("abort", failed);
    if (session === null || session.status !== "active") {
      if (state.kind === "signed-out") return;
      disposeRouter();
      state = { kind: "signed-out" };
    } else {
      if (state.kind === "signed-in" && state.sessionId === session.id) return;
      disposeRouter();
      const directory = clerkDirectory(clerk);
      const router = createWorkspaceRouter(
        directory,
        async (requestSignal) => {
          const verificationSignal = AbortSignal.any([
            requestSignal,
            lifetime.signal,
            AbortSignal.timeout(10_000),
          ]);
          if (clerk.session?.id !== session.id)
            throw new WorkspaceError("FORBIDDEN");
          const token = await waitForClerk(
            () => session.getToken(),
            verificationSignal,
          );
          if (!token) throw new WorkspaceError("FORBIDDEN");
          const result = await fetch("/api/session", {
            headers: { Authorization: `Bearer ${token}` },
            signal: verificationSignal,
          });
          if (!result.ok)
            throw new WorkspaceError(
              result.status === 401 ? "FORBIDDEN" : "UNAVAILABLE",
            );
          const data: unknown = await result.json();
          sessionSchema.parse(data);
          verificationSignal.throwIfAborted();
        },
        MobiusManagement,
      );
      state = { kind: "signed-in", sessionId: session.id, router };
    }
    render();
  });
  function failed() {
    if (state.kind !== "loading") return;
    state = { kind: "failed" };
    render();
  }
  signal.addEventListener("abort", failed, { once: true });
  lifetime.signal.addEventListener(
    "abort",
    () => {
      unsubscribe();
      disposeRouter();
      signal.removeEventListener("abort", failed);
    },
    { once: true },
  );
}

void start().catch(() => {
  if (!lifetime.signal.aborted)
    root.render(
      <Page>
        <p role="alert" className="text-red-700">
          Sign-in is temporarily unavailable. Please reload to try again.
        </p>
      </Page>,
    );
});
