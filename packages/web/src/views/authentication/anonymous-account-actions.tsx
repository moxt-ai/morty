import { QrCode } from "lucide-react";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Popover } from "../../components/ui/popover.tsx";
import { useApiTransport } from "../../services/api/api-transport-context.tsx";
import { AnonymousIdentityApi, type IdentityTransfer } from "../../services/identity/anonymous-identity-api.ts";
import { createAnonymousTransferStore } from "../../view-models/authentication/anonymous-transfer-store.ts";

export function AnonymousAccountActions({
    token,
    signedIn = false,
    createTransfer,
}: {
    readonly token: string;
    readonly signedIn?: boolean;
    readonly createTransfer?: (token: string, signal: AbortSignal) => Promise<IdentityTransfer>;
}) {
    const transport = useApiTransport();
    const [identityApi] = useState(
        () =>
            new AnonymousIdentityApi({
                fetchRequest: transport.fetch,
                origin: window.location.origin,
                storage: window.localStorage,
            }),
    );
    const [open, setOpen] = useState(false);
    const [store] = useState(() => createAnonymousTransferStore(token, createTransfer ?? identityApi.createTransfer));
    const { load, reset, state } = useStore(store);
    useEffect(() => {
        if (!open) {
            reset();
            return;
        }
        const controller = new AbortController();
        void load(controller.signal);
        return () => controller.abort();
    }, [load, open, reset]);
    return (
        <div className="flex items-center gap-2">
            <Popover.Root open={open} onOpenChange={setOpen}>
                <Popover.Trigger asChild>
                    <Button variant="ghost" size="icon" aria-label="Use this workspace on another device">
                        <QrCode aria-hidden="true" className="size-5" />
                    </Button>
                </Popover.Trigger>
                <Popover.Portal>
                    <Popover.Content
                        align="end"
                        sideOffset={8}
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
                                    {new Date(state.transfer.expiresAt).toLocaleTimeString()} and can be used up to five
                                    times.
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
