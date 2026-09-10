import { QrCode } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Popover } from "../../components/ui/popover.tsx";
import { AnonymousIdentityApi, type IdentityTransfer } from "../../services/identity/anonymous-identity-api.ts";

type TransferState =
    | { readonly kind: "idle" }
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly image: string; readonly transfer: IdentityTransfer }
    | { readonly kind: "failed" };

export function AnonymousAccountActions({
    token,
    signedIn = false,
    createTransfer,
}: {
    readonly token: string;
    readonly signedIn?: boolean;
    readonly createTransfer?: (token: string, signal: AbortSignal) => Promise<IdentityTransfer>;
}) {
    const [open, setOpen] = useState(false);
    const [state, setState] = useState<TransferState>({ kind: "idle" });
    useEffect(() => {
        if (!open) {
            return;
        }
        const controller = new AbortController();
        setState({ kind: "loading" });
        const transferRequest =
            createTransfer ??
            new AnonymousIdentityApi({ origin: window.location.origin, storage: window.localStorage }).createTransfer;
        void transferRequest(token, controller.signal).then(
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
    }, [createTransfer, open, token]);
    return (
        <div className="flex items-center gap-2">
            <Popover.Root open={open} onOpenChange={setOpen}>
                <Popover.Trigger asChild>
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Use this workspace on another device"
                        onMouseEnter={() => setOpen(true)}
                    >
                        <QrCode aria-hidden="true" className="size-5" />
                    </Button>
                </Popover.Trigger>
                <Popover.Portal>
                    <Popover.Content
                        align="end"
                        sideOffset={8}
                        onMouseLeave={() => setOpen(false)}
                        className="z-50 w-72 rounded-xl border border-border bg-card p-4 text-center shadow-lg"
                    >
                        <h2 className="text-sm font-semibold">Use on your phone</h2>
                        {state.kind === "ready" ? (
                            <>
                                <img
                                    className="mx-auto my-3 size-56"
                                    src={state.image}
                                    alt="Anonymous workspace transfer QR code"
                                />
                                <p className="text-xs leading-5 text-muted-foreground">
                                    Scan to use this workspace. This code expires at{" "}
                                    {new Date(state.transfer.expiresAt).toLocaleTimeString()} and can be used once.
                                </p>
                            </>
                        ) : state.kind === "failed" ? (
                            <p role="alert" className="my-4 text-sm text-red-700">
                                Could not create a transfer code.
                            </p>
                        ) : (
                            <p role="status" className="my-4 text-sm text-muted-foreground">
                                Creating secure QR code…
                            </p>
                        )}
                        <Popover.Arrow className="fill-border" />
                    </Popover.Content>
                </Popover.Portal>
            </Popover.Root>
            {!signedIn && (
                <Button asChild variant="outline" size="sm">
                    <a href="/login">Sign in</a>
                </Button>
            )}
        </div>
    );
}
