import QRCode from "qrcode";
import { useEffect, useState } from "react";
import type { IdentityTransfer } from "../../services/identity/anonymous-identity-api.ts";

type State =
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly image: string; readonly transfer: IdentityTransfer }
    | { readonly kind: "failed" };

export function MachineSharing({
    createTransfer,
}: {
    readonly createTransfer: (signal: AbortSignal) => Promise<IdentityTransfer>;
}) {
    const [state, setState] = useState<State>({ kind: "loading" });
    useEffect(() => {
        const controller = new AbortController();
        void createTransfer(controller.signal).then(
            async (transfer) => {
                const image = await QRCode.toDataURL(transfer.url, { margin: 1, width: 224 });
                if (!controller.signal.aborted) {
                    setState({ image, kind: "ready", transfer });
                }
            },
            () => {
                if (!controller.signal.aborted) {
                    setState({ kind: "failed" });
                }
            },
        );
        return () => controller.abort();
    }, [createTransfer]);

    if (state.kind === "loading") {
        return <p role="status">Creating secure QR code…</p>;
    }
    if (state.kind === "failed") {
        return <p role="alert">Could not create a sharing link.</p>;
    }
    return (
        <div className="space-y-4 text-center">
            <img className="mx-auto size-56" src={state.image} alt="Machine sharing QR code" />
            <a
                className="block break-all font-mono text-xs text-primary underline underline-offset-4"
                href={state.transfer.url}
                target="_blank"
                rel="noreferrer"
                aria-label="Open sharing link"
            >
                {state.transfer.url}
            </a>
            <p className="text-xs leading-5 text-muted-foreground">
                This link expires at {new Date(state.transfer.expiresAt).toLocaleTimeString()} and can be used up to
                five times.
            </p>
        </div>
    );
}
