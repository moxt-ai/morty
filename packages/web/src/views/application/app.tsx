import { SignOutButton, UserButton } from "@clerk/react";
import { type AnyRouter, RouterProvider } from "@tanstack/react-router";
import type { ReactNode } from "react";

export type AppState =
    | { readonly kind: "loading" }
    | { readonly kind: "failed" }
    | { readonly kind: "authentication"; readonly router: AnyRouter }
    | {
          readonly kind: "signed-in";
          readonly router: AnyRouter;
      };

export function Page({ children, account }: { readonly children: ReactNode; readonly account?: ReactNode }) {
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

export function App({ state }: { readonly state: AppState }) {
    switch (state.kind) {
        case "loading":
            return (
                <Page>
                    <p role="status">Loading Mobius Cloud…</p>
                </Page>
            );
        case "failed":
            return (
                <Page>
                    <p role="alert" className="text-red-700">
                        Sign-in is temporarily unavailable. Please reload to try again.
                    </p>
                </Page>
            );
        case "authentication":
            return <RouterProvider router={state.router} />;
        case "signed-in":
            return (
                <Page
                    account={
                        <div className="flex items-center gap-5">
                            <SignOutButton redirectUrl="/">
                                <button type="button" className="text-sm text-zinc-500 hover:text-zinc-900">
                                    Sign out
                                </button>
                            </SignOutButton>
                            <UserButton />
                        </div>
                    }
                >
                    <RouterProvider router={state.router} />
                </Page>
            );
    }
}
