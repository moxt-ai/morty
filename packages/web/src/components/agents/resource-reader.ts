export type SessionResourceReader = (
    path: string,
    signal: AbortSignal,
) => Promise<{ readonly bytes: Uint8Array; readonly mediaType: string }>;

export type SessionResourceRequest = {
    readonly path: string;
    readonly kind: "image" | "raster-image" | "text" | "binary" | "audio" | "download";
};

export type SessionResourceState =
    | { readonly kind: "loading" }
    | { readonly kind: "failed" }
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "media"; readonly source: string };

export interface SessionResourceStore {
    readonly state: SessionResourceState;
    readonly onAttach: (node: HTMLElement | null) => (() => void) | undefined;
}

/**
 * The injected view-model factory that owns the resource workflow. Declared
 * here so components stay decoupled from the view-model layer while views
 * pass the concrete implementation down explicitly.
 */
export type SessionResourceStoreFactory = (
    request: SessionResourceRequest,
    read: SessionResourceReader | undefined,
) => {
    readonly getInitialState: () => SessionResourceStore;
    readonly getState: () => SessionResourceStore;
    readonly subscribe: (
        listener: (state: SessionResourceStore, prevState: SessionResourceStore) => void,
    ) => () => void;
};
