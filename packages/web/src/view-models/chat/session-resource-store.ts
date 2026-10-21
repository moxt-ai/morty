import { createStore } from "zustand/vanilla";
import { createFilePreviewImage } from "../../services/chat/file-preview-surface.ts";
import { isDisplayableImageType, isRasterImageType } from "../../services/chat/image-media-type.ts";

export type SessionResourceReader = (
    path: string,
    signal: AbortSignal,
) => Promise<{ readonly bytes: Uint8Array; readonly mediaType: string }>;

export interface SessionResourceRequest {
    readonly path: string;
    readonly kind: "image" | "raster-image" | "text" | "binary";
}

export type SessionResourceState =
    | { readonly kind: "loading" }
    | { readonly kind: "failed" }
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "media"; readonly source: string };

interface SessionResourceStore {
    readonly state: SessionResourceState;
    readonly onAttach: (node: HTMLElement | null) => (() => void) | undefined;
}

export function createSessionResourceStore(request: SessionResourceRequest, read: SessionResourceReader | undefined) {
    return createStore<SessionResourceStore>()((set) => ({
        state: { kind: "loading" },
        onAttach: (node) => {
            if (node === null) {
                return;
            }
            const lifetime = new AbortController();
            let media: ReturnType<typeof createFilePreviewImage> | null = null;
            const load = async (signal: AbortSignal): Promise<void> => {
                set({ state: { kind: "loading" } });
                try {
                    if (read === undefined || request.path.length === 0) {
                        set({ state: { kind: "failed" } });
                        return;
                    }
                    const file = await read(request.path, AbortSignal.any([signal, AbortSignal.timeout(20_000)]));
                    signal.throwIfAborted();
                    if (request.kind === "text") {
                        set({ state: { kind: "text", text: new TextDecoder().decode(file.bytes) } });
                    } else if (
                        (request.kind === "image" && !isDisplayableImageType(file.mediaType)) ||
                        (request.kind === "raster-image" && !isRasterImageType(file.mediaType))
                    ) {
                        set({ state: { kind: "failed" } });
                    } else {
                        media = createFilePreviewImage(file.bytes, file.mediaType);
                        set({ state: { kind: "media", source: media.source } });
                    }
                } catch {
                    if (!signal.aborted) {
                        set({ state: { kind: "failed" } });
                    }
                }
            };
            void load(lifetime.signal);
            return () => {
                lifetime.abort(new DOMException("The Session resource view detached.", "AbortError"));
                media?.dispose();
            };
        },
    }));
}
