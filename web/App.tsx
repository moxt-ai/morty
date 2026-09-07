import {
  SignInButton,
  SignOutButton,
  SignUpButton,
  UserButton,
} from "@clerk/react";
import type { ReactNode } from "react";
import { RouterProvider } from "react-router/dom";
import type { createWorkspaceRouter } from "./workspaces/router.tsx";

export type AppState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "signed-out" }
  | {
      readonly kind: "signed-in";
      readonly sessionId: string;
      readonly router: ReturnType<typeof createWorkspaceRouter>;
    };

export function Page({
  children,
  account,
}: {
  readonly children: ReactNode;
  readonly account?: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-stone-50 text-zinc-900">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex h-18 max-w-5xl items-center justify-between px-6">
          <a
            className="flex items-center gap-3 font-semibold tracking-tight"
            href="/"
            aria-label="Mobius Cloud home"
          >
            <span
              aria-hidden="true"
              className="flex size-9 items-center justify-center rounded-xl bg-zinc-900 text-2xl text-white"
            >
              ∞
            </span>
            Mobius Cloud
          </a>
          {account ?? (
            <span className="text-xs font-medium uppercase tracking-widest text-zinc-500">
              Your agents. Connected.
            </span>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-12 sm:py-16">{children}</main>
    </div>
  );
}

const buttonClass =
  "inline-flex min-h-11 items-center justify-center rounded-lg px-5 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-violet-600";

export function App({ state }: { readonly state: AppState }) {
  let content: ReactNode;
  switch (state.kind) {
    case "loading":
      content = <p role="status">Loading Mobius Cloud…</p>;
      break;
    case "failed":
      content = (
        <p role="alert" className="text-red-700">
          Sign-in is temporarily unavailable. Please reload to try again.
        </p>
      );
      break;
    case "signed-in":
      content = <RouterProvider router={state.router} />;
      break;
    case "signed-out":
      content = (
        <section className="mx-auto max-w-xl rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm sm:p-10">
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-violet-700">
            A place for your agents
          </p>
          <h1 className="text-3xl font-semibold leading-tight tracking-tight">
            Welcome to Mobius Cloud
          </h1>
          <p className="mt-4 leading-7 text-zinc-600">
            Sign in to your account, or create one to get started.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <SignInButton mode="modal">
              <button
                type="button"
                className={`${buttonClass} bg-violet-700 text-white hover:bg-violet-800`}
              >
                Sign in
              </button>
            </SignInButton>
            <SignUpButton mode="modal">
              <button
                type="button"
                className={`${buttonClass} border border-zinc-300 bg-white hover:bg-zinc-50`}
              >
                Create account
              </button>
            </SignUpButton>
          </div>
        </section>
      );
      break;
  }
  return (
    <Page
      account={
        state.kind === "signed-in" ? (
          <div className="flex items-center gap-5">
            <SignOutButton redirectUrl="/">
              <button
                type="button"
                className="text-sm text-zinc-500 hover:text-zinc-900"
              >
                Sign out
              </button>
            </SignOutButton>
            <UserButton />
          </div>
        ) : undefined
      }
    >
      {content}
    </Page>
  );
}
