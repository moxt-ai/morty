import { MortyLoadingMark } from "../../components/brand/morty-loading-mark.tsx";

const loadingPageBackgroundClassName = "bg-[radial-gradient(circle_at_top,_#f6f7f9_0%,_#f0f1f4_48%)]";

/** One whole-document loading surface for every application entry point. */
export function GlobalLoadingPage({ label }: { readonly label: string }) {
    return (
        <main
            className={`flex min-h-screen flex-col items-center justify-center overflow-y-auto ${loadingPageBackgroundClassName} px-6 py-12 text-foreground`}
        >
            <span role="status" aria-label={label}>
                <MortyLoadingMark />
            </span>
        </main>
    );
}
