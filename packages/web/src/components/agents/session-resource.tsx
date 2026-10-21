import { type ReactNode, useMemo } from "react";
import { useStore } from "zustand";
import {
    createSessionResourceStore,
    type SessionResourceReader,
    type SessionResourceRequest,
    type SessionResourceState,
} from "../../view-models/chat/session-resource-store.ts";

export function SessionResource({
    request,
    read,
    inline = false,
    children,
}: {
    readonly request: SessionResourceRequest;
    readonly read: SessionResourceReader | undefined;
    readonly inline?: boolean;
    readonly children: (state: SessionResourceState) => ReactNode;
}) {
    const { path, kind } = request;
    const store = useMemo(() => createSessionResourceStore({ path, kind }, read), [path, kind, read]);
    const model = useStore(store);
    return inline ? (
        <span className="contents" ref={model.onAttach}>
            {children(model.state)}
        </span>
    ) : (
        <div className="contents" ref={model.onAttach}>
            {children(model.state)}
        </div>
    );
}
