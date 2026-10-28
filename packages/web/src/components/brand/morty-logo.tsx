import { useState } from "react";
import { cn } from "@/lib/utils";
import { dataTestId } from "../../data-testid.ts";

/**
 * The Morty brand mark, rendered from the single artwork source in
 * `public/morty-logo.svg`. The tab icon and share card are generated from the
 * same file, so in-app and off-site marks cannot drift apart.
 *
 * The mark is decorative: every call site pairs it with the `Morty` wordmark, a
 * link name, or a button label.
 */
type MortyLogoState = { readonly kind: "loading" } | { readonly kind: "loaded" } | { readonly kind: "failed" };

export function MortyLogoMark({ className, size = 36 }: { readonly className?: string; readonly size?: number }) {
    const [state, setState] = useState<MortyLogoState>({ kind: "loading" });

    return (
        <span
            className={cn("relative inline-flex shrink-0 select-none", className)}
            data-state={state.kind}
            data-testid={dataTestId.mortyLogo}
            style={{ height: size, width: size }}
        >
            {state.kind === "loading" && (
                <span
                    aria-hidden="true"
                    className="absolute inset-0 animate-pulse rounded-[22%] bg-muted motion-reduce:animate-none"
                />
            )}
            {state.kind !== "failed" && (
                <img
                    alt=""
                    className={cn(
                        "block size-full transition-opacity duration-150",
                        state.kind === "loaded" ? "opacity-100" : "opacity-0",
                    )}
                    draggable={false}
                    height={size}
                    onError={() => setState({ kind: "failed" })}
                    onLoad={() => setState({ kind: "loaded" })}
                    src="/morty-logo.svg"
                    width={size}
                />
            )}
        </span>
    );
}
