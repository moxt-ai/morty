import { SignOutButton, UserButton } from "@clerk/react";
import { Button } from "@moxt-ai/mobius-cloud-web-core";
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
        <div className="min-h-screen bg-background font-sans text-foreground">
            <header className="border-b border-border bg-card">
                <div className="mx-auto flex min-h-16 max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
                    <a
                        className="flex items-center gap-3 font-semibold tracking-tight"
                        href="/"
                        aria-label="Mobius Cloud home"
                    >
                        <span
                            aria-hidden="true"
                            className="flex size-9 items-center justify-center rounded-lg bg-primary text-2xl text-primary-foreground"
                        >
                            ∞
                        </span>
                        Mobius Cloud
                    </a>
                    {account ?? <span className="text-xs text-muted-foreground">Your agents. Connected.</span>}
                </div>
            </header>
            <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">{children}</main>
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
                                <Button variant="ghost" size="sm">
                                    Sign out
                                </Button>
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
