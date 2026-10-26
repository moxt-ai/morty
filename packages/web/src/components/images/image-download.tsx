import { Download } from "lucide-react";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

export interface ViewerImage {
    readonly src: string;
    readonly name: string;
    readonly blob?: Blob | undefined;
}

export interface ImageDownloadModel {
    readonly state: { readonly kind: "idle" | "saving" } | { readonly kind: "failed"; readonly message: string };
    readonly onAttach: (node: HTMLElement | null) => (() => void) | undefined;
    readonly save: (image: ViewerImage) => void;
}

type DownloadFactory = () => StoreApi<ImageDownloadModel>;
const DownloadContext = createContext<DownloadFactory | null>(null);

export function ImageDownloadProvider({
    createStore,
    children,
}: {
    readonly createStore: DownloadFactory;
    readonly children: ReactNode;
}) {
    return <DownloadContext value={createStore}>{children}</DownloadContext>;
}

export const imageControlClass =
    "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-lg px-3 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40 aria-disabled:opacity-40";

export function ImageDownload({ image }: { readonly image: ViewerImage }) {
    const factory = useContext(DownloadContext);
    return factory === null ? null : <DownloadControl factory={factory} image={image} />;
}

function DownloadControl({ factory, image }: { readonly factory: DownloadFactory; readonly image: ViewerImage }) {
    const store = useMemo(factory, [factory]);
    const model = useStore(store);
    return (
        <span className="contents" ref={model.onAttach}>
            <button
                aria-label="Download image"
                className={imageControlClass}
                disabled={model.state.kind === "saving"}
                onClick={() => model.save(image)}
                type="button"
            >
                <Download aria-hidden="true" className="size-4" />
                <span className="sr-only">Download image</span>
            </button>
            {model.state.kind === "failed" && (
                <span className="max-w-64 text-xs" role="alert">
                    {model.state.message}{" "}
                    <a className="underline" href={image.src} rel="noreferrer" target="_blank">
                        Open original
                    </a>
                </span>
            )}
        </span>
    );
}
