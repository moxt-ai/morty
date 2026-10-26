import { LoaderCircle, SquareTerminal } from "lucide-react";
import { cn } from "@/lib/utils";

/** Agent harness products with a distinct brand mark. */
export type HarnessProduct = "claude" | "codex" | "pi" | "generic";

// Brand marks are inlined rather than pulled from a package so that a harness
// can only render a mark the build actually ships. `agentRef` is an identifier,
// never a display string, so identity is matched exactly before the label is
// consulted as a fallback.
const HARNESS_PRODUCTS: readonly { readonly agentRefs: readonly string[]; readonly product: HarnessProduct }[] = [
    { agentRefs: ["claude", "claude-code"], product: "claude" },
    { agentRefs: ["codex", "openai"], product: "codex" },
    { agentRefs: ["pi"], product: "pi" },
];

const MARK_BACKGROUNDS: Readonly<Partial<Record<HarnessProduct, string>>> = {
    claude: "bg-[#d97757] text-[#2d1a14]",
    codex: "bg-[#171717] text-white",
};

// Paths are transcribed from each product's published logo and must stay
// faithful to it: a plausible-looking invented glyph still reads to a user as
// that product's real mark. Line marks are the mono glyphs used beside model
// names: currentColor, with no colored tile.
const CLAUDE_LINE_PATH =
    "m240.004 659.672l176.117-98.825l2.949-8.613l-2.95-4.76h-8.612l-29.467-1.814l-100.636-2.722l-87.267-3.625l-84.545-4.532l-21.306-4.536l-19.947-26.29l2.038-13.15l17.909-12.013l25.61 2.27l56.669 3.853l84.997 5.89l61.652 3.63l91.347 9.52h14.508l2.038-5.895l-4.987-3.625l-3.853-3.63l-87.943-59.61l-95.2-63.014l-49.862-36.266l-26.973-18.36l-13.6-17.226l-5.892-37.624l24.48-26.974l32.864 2.266l8.385 2.266l33.32 25.611l71.172 55.082l92.934 68.454l13.6 11.33l5.44-3.852l.68-2.718l-6.123-10.203l-50.546-91.344l-53.946-92.933l-24.024-38.528l-6.347-23.125c-2.266-9.52-3.853-17.45-3.853-27.197l27.88-37.856L314.123 64l37.173 4.988l15.643 13.597l23.116 52.815l37.4 83.186l58.028 113.105l16.998 33.544l9.068 31.054l3.398 9.52h5.894v-5.44l4.76-63.69l8.841-78.202l8.613-100.64L546 129.505l14.053-34l27.88-18.36l21.758 10.427l17.909 25.61l-2.494 16.55l-10.651 69.13L593.6 307.208L580 379.743h7.933l9.068-9.068l36.718-48.732l61.652-77.067l27.201-30.598l31.733-33.772l20.4-16.094h38.531l28.336 42.16l-12.693 43.52l-39.667 50.318l-32.868 42.612l-47.145 63.467l-29.467 50.773l2.722 4.08l7.026-.683l106.53-22.661l57.572-10.431l68.679-11.786l31.054 14.508l3.397 14.731l-12.238 30.147l-73.435 18.133l-86.135 17.225L656.61 540.9l-1.587 1.135l1.814 2.266l57.8 5.44l24.707 1.358h60.517l112.654 8.389l29.463 19.488l17.681 23.804l-2.95 18.132l-45.33 23.121l-61.2-14.508l-142.8-34l-48.955-12.24h-6.802v4.08l40.801 39.894l74.798 67.544l93.613 87.039l4.76 21.533l-12.014 17.002l-12.693-1.814l-82.279-61.88l-31.733-27.88l-71.852-60.518h-4.76v6.346l16.546 24.252l87.494 131.466l4.533 40.346l-6.347 13.145l-22.665 7.933l-24.935-4.532l-51.225-71.852l-52.812-80.92l-42.612-72.53l-5.215 2.948l-25.163 270.861l-11.783 13.825L488.88 960l-22.666-17.226l-12.014-27.88l12.014-55.078l14.508-71.852l11.786-57.12l10.651-70.948l6.347-23.572l-.452-1.587l-5.215.68l-53.491 73.442l-81.372 109.931l-64.374 68.903l-15.411 6.122l-26.746-13.828l2.49-24.707l14.964-21.986l89.077-113.332l53.719-70.262l34.683-40.574l-.232-5.895h-2.038L218.47 756.911l-42.16 5.439l-18.133-17.002l2.27-27.877l8.613-9.068l71.172-48.959Z";

const CODEX_LINE_PATHS = [
    "M11.745 14.85L6.905 12V7c0-2.21 1.824-4 4.076-4c1.397 0 2.63.69 3.365 1.741",
    "M9.6 19.18A4.1 4.1 0 0 0 13.02 21c2.25 0 4.076-1.79 4.076-4v-5L12.16 9.097",
    "M9.452 13.5V7.67l4.412-2.5c1.95-1.105 4.443-.45 5.569 1.463a3.93 3.93 0 0 1 .076 3.866",
    "M4.49 13.5a3.93 3.93 0 0 0 .075 3.866c1.126 1.913 3.62 2.568 5.57 1.464l4.412-2.5l.096-5.596",
    "M17.096 17.63a4.09 4.09 0 0 0 3.357-1.996c1.126-1.913.458-4.36-1.492-5.464l-4.413-2.5l-5.059 2.755",
    "M6.905 6.37a4.09 4.09 0 0 0-3.358 1.996c-1.126 1.914-.458 4.36 1.492 5.464l4.413 2.5l5.048-2.75",
] as const;

const MARK_PATHS: Readonly<Partial<Record<HarnessProduct, string>>> = {
    claude: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
    codex: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
    pi: "M0 0v24h6v-6h6v-6H6V6h6v6h6V0Zm18 12v12h6V12Z",
};

function identifyHarnessProduct(agentRef: string, label: string): HarnessProduct {
    const identity = agentRef.toLowerCase();
    const exact = HARNESS_PRODUCTS.find((entry) => entry.agentRefs.includes(identity));
    if (exact !== undefined) {
        return exact.product;
    }
    const guess = label.toLowerCase();
    if (guess.includes("claude")) {
        return "claude";
    }
    if (guess.includes("codex") || guess.includes("openai")) {
        return "codex";
    }
    return "generic";
}

export function HarnessMark({
    agentRef,
    appearance = "badge",
    className,
    label,
    loading = false,
    testId,
}: {
    readonly agentRef: string;
    readonly appearance?: "badge" | "line";
    readonly className?: string;
    readonly label: string;
    readonly loading?: boolean;
    readonly testId: string;
}) {
    if (loading) {
        return (
            <LoaderCircle
                aria-hidden="true"
                className={cn(
                    "shrink-0 animate-spin motion-reduce:animate-none",
                    appearance === "line" ? "size-4" : "size-5",
                    className,
                )}
                data-testid={testId}
            />
        );
    }
    const product = identifyHarnessProduct(agentRef, label);
    if (appearance === "line" && product === "codex") {
        return (
            <svg
                aria-hidden="true"
                className={cn("size-[17px] shrink-0", className)}
                data-harness-product={product}
                data-testid={testId}
                fill="none"
                viewBox="0 0 24 24"
            >
                <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5">
                    {CODEX_LINE_PATHS.map((d) => (
                        <path d={d} key={d} />
                    ))}
                </g>
            </svg>
        );
    }
    if (appearance === "line" && product === "claude") {
        return (
            <svg
                aria-hidden="true"
                className={cn("size-4 shrink-0", className)}
                data-harness-product={product}
                data-testid={testId}
                fill="none"
                viewBox="0 0 1024 1024"
            >
                <path d={CLAUDE_LINE_PATH} fill="currentColor" />
            </svg>
        );
    }
    const path = MARK_PATHS[product];
    return (
        <span
            aria-hidden="true"
            className={cn(
                "inline-flex size-5 shrink-0 items-center justify-center rounded-[6px]",
                appearance === "line" ? "text-current" : "text-muted-foreground",
                MARK_BACKGROUNDS[product],
                className,
            )}
            data-harness-product={product}
            data-testid={testId}
        >
            {path === undefined ? (
                <SquareTerminal aria-hidden="true" className="size-[12px]" />
            ) : (
                <svg aria-hidden="true" className="size-[12px]" fill="currentColor" viewBox="0 0 24 24">
                    <path d={path} />
                </svg>
            )}
        </span>
    );
}
