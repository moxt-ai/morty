import { CircleCheck, CircleMinus, CircleX, LoaderCircle } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ToolCallState } from "../../../services/chat/agent-reply.ts";

export function useToolCallDisclosure(autoOpen: boolean) {
    const disclosure = useRef<HTMLDetailsElement>(null);
    useEffect(() => {
        if (autoOpen && disclosure.current !== null) {
            disclosure.current.open = true;
        }
    }, [autoOpen]);
    return disclosure;
}

export function ToolCallStatus({ state }: { readonly state: ToolCallState }) {
    switch (state.kind) {
        case "running":
            return (
                <LoaderCircle
                    aria-label="Tool running"
                    className="size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none"
                />
            );
        case "succeeded":
            return <CircleCheck aria-label="Tool succeeded" className="size-4 shrink-0 text-emerald-600" />;
        case "failed":
            return <CircleX aria-label="Tool failed" className="size-4 shrink-0 text-destructive" />;
        case "interrupted":
            return <CircleMinus aria-label="Tool interrupted" className="size-4 shrink-0 text-muted-foreground" />;
        case "unknown":
            return null;
    }
}
