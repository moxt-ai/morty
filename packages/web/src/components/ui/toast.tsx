import { Check, CircleAlert, X } from "lucide-react";
import { Toast as Primitive } from "radix-ui";
import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from "react";

export interface ToastMessage {
    readonly description?: string | undefined;
    readonly title: string;
    readonly variant?: "success" | "error" | undefined;
}

type ToastState =
    | { readonly kind: "hidden" }
    | { readonly id: number; readonly kind: "visible"; readonly message: ToastMessage };

type ShowToast = (message: ToastMessage) => void;

const ToastContext = createContext<ShowToast | null>(null);

export function ToastProvider({ children }: { readonly children: ReactNode }) {
    const nextId = useRef(0);
    const [state, setState] = useState<ToastState>({ kind: "hidden" });
    const showToast = useCallback((message: ToastMessage) => {
        nextId.current += 1;
        setState({ id: nextId.current, kind: "visible", message });
    }, []);

    return (
        <ToastContext.Provider value={showToast}>
            <Primitive.Provider duration={3000} swipeDirection="down">
                {children}
                {state.kind === "visible" && (
                    <Primitive.Root
                        className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 rounded-lg border border-border bg-background px-4 py-3 text-sm text-foreground shadow-lg data-[state=closed]:animate-out data-[state=open]:animate-cloud-enter"
                        key={state.id}
                        onOpenChange={(open) => {
                            if (!open) {
                                setState({ kind: "hidden" });
                            }
                        }}
                        open
                    >
                        {state.message.variant === "error" ? (
                            <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-destructive" />
                        ) : (
                            <Check aria-hidden="true" className="size-4 shrink-0 text-primary" />
                        )}
                        <div className="min-w-0">
                            <Primitive.Title className="font-medium">{state.message.title}</Primitive.Title>
                            {state.message.description !== undefined && (
                                <Primitive.Description className="mt-0.5 text-xs text-muted-foreground">
                                    {state.message.description}
                                </Primitive.Description>
                            )}
                        </div>
                        <Primitive.Close
                            aria-label="Dismiss notification"
                            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/70"
                        >
                            <X aria-hidden="true" className="size-3.5" />
                        </Primitive.Close>
                    </Primitive.Root>
                )}
                <Primitive.Viewport className="fixed bottom-6 left-1/2 z-[100] m-0 flex w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 list-none flex-col gap-2 outline-none" />
            </Primitive.Provider>
        </ToastContext.Provider>
    );
}

export function useToast(): ShowToast {
    const showToast = useContext(ToastContext);
    if (showToast === null) {
        throw new Error("useToast must be used inside ToastProvider");
    }
    return showToast;
}
