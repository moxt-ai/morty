import { type ReactNode, useMemo } from "react";
import { useStore } from "zustand";
import type {
    SessionResourceReader,
    SessionResourceRequest,
    SessionResourceState,
    SessionResourceStoreFactory,
} from "./resource-reader.ts";

/**
 * Renders a session-scoped resource through a store created by the injected
 * factory: the factory comes from the view-model layer (passed down from the
 * owning view alongside the reader port), so this component stays
 * business-decoupled while the store owns loading, cancellation, and the
 * object URL's lifetime.
 */
export function SessionResource({
    createStore: createResourceStore,
    request,
    read,
    inline = false,
    children,
}: {
    /** The view-model factory that owns the resource workflow. */
    readonly createStore: SessionResourceStoreFactory;
    readonly request: SessionResourceRequest;
    readonly read: SessionResourceReader | undefined;
    readonly inline?: boolean;
    readonly children: (state: SessionResourceState) => ReactNode;
}) {
    const { path, kind } = request;
    const store = useMemo(() => createResourceStore({ path, kind }, read), [createResourceStore, path, kind, read]);
    const model = useStore(store);
    const retry =
        model.state.kind === "failed" && (kind === "image" || kind === "raster-image") ? (
            <button className="ml-2 text-xs underline" onClick={model.retry} type="button">
                Retry image
            </button>
        ) : null;
    return inline ? (
        <span className="contents" ref={model.onAttach}>
            {children(model.state)}
            {retry}
        </span>
    ) : (
        <div className="contents" ref={model.onAttach}>
            {children(model.state)}
            {retry}
        </div>
    );
}
