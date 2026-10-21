const SIDE_PANEL_QUERY = "(min-width: 40rem) and (hover: hover) and (pointer: fine)";

interface FilePreviewPanel {
    readonly show: (mode: "side-panel" | "modal") => void;
    readonly dispose: () => void;
}

interface FilePreviewImage {
    readonly source: string;
    readonly dispose: () => void;
}

export function filePreviewAllowsSidePanel(): boolean {
    return window.matchMedia(SIDE_PANEL_QUERY).matches;
}

export function observeFilePreviewLayout(update: (sidePanel: boolean) => void): () => void {
    const query = window.matchMedia(SIDE_PANEL_QUERY);
    const receive = () => update(query.matches);
    query.addEventListener("change", receive);
    receive();
    return () => query.removeEventListener("change", receive);
}

export function attachFilePreviewPanel(dialog: HTMLDialogElement): FilePreviewPanel {
    const previousFocus = document.activeElement;
    let currentMode: "side-panel" | "modal" | null = null;
    return {
        show: (mode: "side-panel" | "modal") => {
            if (currentMode === mode) {
                return;
            }
            const focused = document.activeElement;
            const wasOpen = dialog.open;
            if (wasOpen) {
                dialog.close();
            }
            // Change the native dialog mode without replacing its iframe, so
            // interactive content survives resizing and expanding the panel.
            if (mode === "modal") {
                dialog.showModal();
            } else {
                dialog.show();
            }
            currentMode = mode;
            if (wasOpen && focused instanceof HTMLElement && dialog.contains(focused)) {
                focused.focus({ preventScroll: true });
            } else {
                dialog.querySelector<HTMLElement>("[data-preview-initial-focus]")?.focus({ preventScroll: true });
            }
        },
        dispose: () => {
            dialog.close();
            if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
                previousFocus.focus({ preventScroll: true });
            }
        },
    };
}

export function createFilePreviewImage(bytes: Uint8Array, mediaType: string): FilePreviewImage {
    const source = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: mediaType }));
    return { source, dispose: () => URL.revokeObjectURL(source) };
}
