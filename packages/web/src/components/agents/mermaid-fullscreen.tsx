import { RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import { Dialog as Primitive } from "radix-ui";
import { type ReactNode, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { useElementSize } from "../utils/use-element-size.ts";

const MIN_SCALE = 0.1;
const MAX_SCALE = 3;
const ZOOM_STEP = 0.1;
/**
 * Mermaid labels render at 16px, so a fit scale below 0.75 draws them under
 * 12px. Open a diagram that cannot fit legibly at this floor and let the
 * reader pan, instead of shrinking the whole graph until it cannot be read.
 */
const MIN_LEGIBLE_SCALE = 0.75;

export type MermaidFullscreenDiagram = {
    readonly height: number;
    readonly markup: string;
    readonly width: number;
};

type View =
    | { readonly kind: "fit" }
    | { readonly kind: "manual"; readonly offsetX: number; readonly offsetY: number; readonly scale: number };

const FIT: View = { kind: "fit" };

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), maximum);
}

function fitScale(
    viewport: { readonly height: number; readonly width: number },
    diagram: MermaidFullscreenDiagram,
): number {
    if (viewport.width <= 0 || viewport.height <= 0 || diagram.width <= 0 || diagram.height <= 0) {
        return 1;
    }
    const fitted = Math.min(viewport.width / diagram.width, viewport.height / diagram.height, 1);
    return clamp(Math.max(fitted, MIN_LEGIBLE_SCALE), MIN_SCALE, 1);
}

function ViewerButton({
    children,
    label,
    onClick,
}: {
    readonly children: ReactNode;
    readonly label: string;
    readonly onClick: () => void;
}) {
    return (
        <button
            aria-label={label}
            className="cursor-pointer rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={onClick}
            title={label}
            type="button"
        >
            {children}
        </button>
    );
}

/**
 * A fullscreen viewer for one rendered Mermaid diagram. It fits the diagram by
 * its intrinsic size and keeps its labels legible, so a wide diagram opens
 * readable and is panned and zoomed rather than scaled down to the viewport.
 */
export function MermaidFullscreen({
    diagram,
    onClose,
}: {
    readonly diagram: MermaidFullscreenDiagram;
    readonly onClose: () => void;
}) {
    const { element: viewport, observe, size } = useElementSize<HTMLDivElement>();
    const drag = useRef<{
        readonly offsetX: number;
        readonly offsetY: number;
        readonly pointerId: number;
        readonly x: number;
        readonly y: number;
    } | null>(null);
    const [view, setView] = useState<View>(FIT);
    const offsetX = view.kind === "manual" ? view.offsetX : 0;
    const offsetY = view.kind === "manual" ? view.offsetY : 0;
    const scale = view.kind === "manual" ? view.scale : size === null ? 1 : fitScale(size, diagram);

    useEffect(() => {
        if (viewport === null) {
            return;
        }
        const onWheel = (event: WheelEvent) => {
            event.preventDefault();
            const step = event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
            setView((current) => ({
                kind: "manual",
                offsetX: current.kind === "manual" ? current.offsetX : 0,
                offsetY: current.kind === "manual" ? current.offsetY : 0,
                scale: clamp(scale + step, MIN_SCALE, MAX_SCALE),
            }));
        };
        viewport.addEventListener("wheel", onWheel, { passive: false });
        return () => viewport.removeEventListener("wheel", onWheel);
    }, [scale, viewport]);

    const zoomBy = (step: number) => {
        setView({ kind: "manual", offsetX, offsetY, scale: clamp(scale + step, MIN_SCALE, MAX_SCALE) });
    };

    const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || !event.isPrimary) {
            return;
        }
        drag.current = {
            offsetX,
            offsetY,
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
        const active = drag.current;
        if (active === null || active.pointerId !== event.pointerId) {
            return;
        }
        setView({
            kind: "manual",
            offsetX: active.offsetX + event.clientX - active.x,
            offsetY: active.offsetY + event.clientY - active.y,
            scale,
        });
    };

    const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
        const active = drag.current;
        if (active === null || active.pointerId !== event.pointerId) {
            return;
        }
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    };

    return (
        <Primitive.Root
            onOpenChange={(open) => {
                if (!open) {
                    onClose();
                }
            }}
            open
        >
            <Primitive.Portal>
                <Primitive.Content
                    aria-label="View diagram fullscreen"
                    className="fixed inset-0 z-50 flex flex-col bg-background/95 p-4 backdrop-blur-sm outline-none"
                >
                    <div className="absolute top-4 right-4 z-10 flex items-center gap-1 rounded-md border border-border bg-background/80 p-1">
                        <ViewerButton
                            label="Zoom out"
                            onClick={() => {
                                zoomBy(-ZOOM_STEP);
                            }}
                        >
                            <ZoomOut aria-hidden="true" size={18} />
                        </ViewerButton>
                        <ViewerButton
                            label="Zoom in"
                            onClick={() => {
                                zoomBy(ZOOM_STEP);
                            }}
                        >
                            <ZoomIn aria-hidden="true" size={18} />
                        </ViewerButton>
                        <ViewerButton
                            label="Reset zoom and pan"
                            onClick={() => {
                                setView(FIT);
                            }}
                        >
                            <RotateCcw aria-hidden="true" size={18} />
                        </ViewerButton>
                        <Primitive.Close asChild>
                            <ViewerButton label="Exit fullscreen" onClick={() => undefined}>
                                <X aria-hidden="true" size={18} />
                            </ViewerButton>
                        </Primitive.Close>
                    </div>
                    <div
                        className="flex size-full cursor-grab touch-none items-center justify-center overflow-hidden select-none active:cursor-grabbing"
                        onPointerCancel={endDrag}
                        onPointerDown={startDrag}
                        onPointerMove={moveDrag}
                        onPointerUp={endDrag}
                        ref={observe}
                    >
                        <div
                            className="shrink-0"
                            style={{
                                transform: `translate(${offsetX}px, ${offsetY}px) scale(${scale})`,
                                transformOrigin: "center center",
                                willChange: "transform",
                            }}
                        >
                            <div
                                aria-label="Mermaid chart"
                                // biome-ignore lint/security/noDangerouslySetInnerHtml: the Mermaid plugin sanitizes this markup with DOMPurify before it reaches the page.
                                dangerouslySetInnerHTML={{ __html: diagram.markup }}
                                role="img"
                            />
                        </div>
                    </div>
                </Primitive.Content>
            </Primitive.Portal>
        </Primitive.Root>
    );
}
