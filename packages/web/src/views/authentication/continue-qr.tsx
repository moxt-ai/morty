import { QrCode } from "lucide-react";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { Dialog } from "../../components/ui/dialog.tsx";
import { Button } from "../../index.ts";
import { createContinueQrStore } from "../../view-models/authentication/continue-qr-store.ts";

function ContinueQrImage({ url }: { readonly url: string }) {
    const [store] = useState(() => createContinueQrStore(url));
    const { load, state } = useStore(store);
    useEffect(() => {
        const controller = new AbortController();
        void load(controller.signal);
        return () => controller.abort();
    }, [load]);
    if (state.kind === "loading") {
        return <p role="status">Creating QR code…</p>;
    }
    if (state.kind === "failed") {
        return <p role="alert">Could not create a QR code.</p>;
    }
    return <img className="size-64" src={state.image} alt="QR code to continue on another device" />;
}

export function ContinueQrPanel({ url }: { readonly url: string }) {
    return (
        <aside className="hidden shrink-0 lg:block">
            <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
                <ContinueQrImage url={url} />
                <p className="mt-3 w-64 text-center text-xs leading-5 text-muted-foreground">
                    Scan to open this page on another device.
                </p>
            </div>
        </aside>
    );
}

export function ContinueQrButton({ url }: { readonly url: string }) {
    const [sharing, setSharing] = useState(false);
    return (
        <>
            <Button
                aria-label="Show QR code"
                className="lg:hidden"
                onClick={() => setSharing(true)}
                size="icon"
                variant="ghost"
            >
                <QrCode aria-hidden="true" className="size-4" />
            </Button>
            {sharing ? (
                <Dialog
                    description="Scan this QR code with a phone or tablet to open the same page there."
                    onClose={() => setSharing(false)}
                    title="Continue on another device"
                >
                    <div className="flex flex-col items-center gap-4">
                        <ContinueQrImage url={url} />
                        <a
                            className="break-all text-center font-mono text-xs text-primary underline underline-offset-4"
                            href={url}
                            aria-label="Open this page on another device"
                        >
                            {url}
                        </a>
                    </div>
                </Dialog>
            ) : null}
        </>
    );
}
