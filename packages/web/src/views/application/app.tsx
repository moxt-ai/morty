import { type AnyRouter, RouterProvider } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Spinner } from "../../index.ts";

export type AppState =
    | { readonly kind: "loading" }
    | { readonly kind: "failed" }
    | { readonly kind: "authentication"; readonly router: AnyRouter }
    | {
          readonly kind: "signed-in";
          readonly router: AnyRouter;
      };

function AppHeader({ account, navigation }: { readonly account?: ReactNode; readonly navigation?: ReactNode }) {
    return (
        <header className="shrink-0 border-b border-border bg-card">
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
                <div className="flex flex-wrap items-center gap-3">
                    {navigation}
                    {account ?? <span className="text-xs text-muted-foreground">Your agents. Connected.</span>}
                </div>
            </div>
        </header>
    );
}

export function Page({
    children,
    account,
    navigation,
}: {
    readonly children: ReactNode;
    readonly account?: ReactNode;
    readonly navigation?: ReactNode;
}) {
    return (
        <div className="min-h-dvh bg-background font-sans text-foreground">
            <AppHeader account={account} navigation={navigation} />
            <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">{children}</main>
        </div>
    );
}

export function App({ state }: { readonly state: AppState }) {
    switch (state.kind) {
        case "loading":
            return (
                <main className="grid min-h-dvh place-items-center bg-background">
                    <div className="flex min-h-40 items-center justify-center">
                        <Spinner label="Loading Mobius Cloud" />
                    </div>
                </main>
            );
        case "failed":
            return (
                <main className="grid min-h-dvh place-items-center bg-background">
                    <p role="alert" className="text-red-700">
                        Sign-in is temporarily unavailable. Please reload to try again.
                    </p>
                </main>
            );
        case "authentication":
            return <RouterProvider router={state.router} />;
        case "signed-in":
            return <RouterProvider router={state.router} />;
    }
}
