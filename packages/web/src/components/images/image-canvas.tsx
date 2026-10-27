import { Maximize, Minus, Plus, RotateCw } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { ImageDownload, imageControlClass, type ViewerImage } from "./image-download.tsx";

type Dimensions = { readonly width: number; readonly height: number };
type DecodedImage = { readonly kind: "loading" | "failed" } | { readonly kind: "ready"; readonly size: Dimensions };
type Zoom = { readonly kind: "fit" } | { readonly kind: "scale"; readonly value: number };

/** Shared by the conversation lightbox and the existing file preview panel. */
export function ImageCanvas({
    image,
    onStep,
    onBackdrop,
    testId,
}: {
    readonly image: ViewerImage;
    readonly onStep?: ((direction: -1 | 1) => void) | undefined;
    readonly onBackdrop?: (() => void) | undefined;
    readonly testId?: string;
}) {
    const [decoded, setDecoded] = useState<DecodedImage>({ kind: "loading" });
    const [viewport, setViewport] = useState<Dimensions>({ width: 1, height: 1 });
    const [zoom, setZoom] = useState<Zoom>({ kind: "fit" });
    const [attempt, setAttempt] = useState(0);
    const [source, setSource] = useState(image.src);
    const surface = useRef<HTMLElement | null>(null);
    const pointers = useRef(new Map<number, { readonly x: number; readonly y: number }>());
    const gesture = useRef({ moved: false, background: false, multiple: false, x: 0, y: 0 });
    const natural = decoded.kind === "ready" ? decoded.size : viewport;
    const fit = Math.min(1, viewport.width / natural.width, viewport.height / natural.height);
    const scale = zoom.kind === "fit" ? fit : zoom.value;
    const changeScale = (value: number) => {
        const next = Math.max(0.05, Math.min(8, value));
        const node = surface.current;
        const left =
            node === null
                ? 0
                : (node.scrollLeft + viewport.width / 2 - Math.max(0, (viewport.width - natural.width * scale) / 2)) /
                  scale;
        const top =
            node === null
                ? 0
                : (node.scrollTop + viewport.height / 2 - Math.max(0, (viewport.height - natural.height * scale) / 2)) /
                  scale;
        setZoom({ kind: "scale", value: next });
        // The ref callback below recenters after React commits the new dimensions.
        center.current = { left: left * next - viewport.width / 2, top: top * next - viewport.height / 2 };
    };
    const center = useRef<{ readonly left: number; readonly top: number } | null>(null);
    const onAttach = useCallback(
        (node: HTMLElement | null) => {
            surface.current = node;
            if (node === null) {
                return;
            }
            // Own a URL for the immutable bytes: the thumbnail may unmount or its file may change.
            const ownedSource = image.blob === undefined ? null : URL.createObjectURL(image.blob);
            setSource(ownedSource ?? image.src);
            const resize = () =>
                setViewport({ width: Math.max(1, node.clientWidth), height: Math.max(1, node.clientHeight) });
            resize();
            const observer = new ResizeObserver(resize);
            observer.observe(node);
            return () => {
                observer.disconnect();
                if (ownedSource !== null) {
                    URL.revokeObjectURL(ownedSource);
                }
                surface.current = null;
            };
        },
        [image.blob, image.src],
    );
    return (
        <div className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden">
            <div className="flex shrink-0 flex-wrap items-center justify-center gap-1 border-b border-border bg-surface-elevated px-2 py-1">
                <button
                    aria-label="Zoom out"
                    className={imageControlClass}
                    disabled={decoded.kind !== "ready" || scale <= 0.05}
                    onClick={() => changeScale(scale / 1.5)}
                    type="button"
                >
                    <Minus aria-hidden="true" className="size-4" />
                </button>
                <output aria-label="Zoom level" className="min-w-12 text-center text-xs tabular-nums">
                    {decoded.kind === "ready" ? `${Math.round(scale * 100)}%` : "—"}
                </output>
                <button
                    aria-label="Zoom in"
                    className={imageControlClass}
                    disabled={decoded.kind !== "ready" || scale >= 8}
                    onClick={() => changeScale(scale * 1.5)}
                    type="button"
                >
                    <Plus aria-hidden="true" className="size-4" />
                </button>
                <button
                    aria-label="Fit image"
                    aria-pressed={zoom.kind === "fit"}
                    className={imageControlClass}
                    onClick={() => setZoom({ kind: "fit" })}
                    type="button"
                >
                    <Maximize aria-hidden="true" className="size-4" />
                    <span className="hidden sm:inline">Fit</span>
                </button>
                <button
                    aria-label="Actual size"
                    aria-pressed={zoom.kind === "scale" && zoom.value === 1}
                    className={imageControlClass}
                    onClick={() => changeScale(1)}
                    type="button"
                >
                    100%
                </button>
                <ImageDownload image={{ ...image, src: source }} />
            </div>
            <section
                aria-label="Image canvas"
                className="relative min-h-0 flex-1 touch-none overflow-auto overscroll-contain bg-surface-subtle outline-none keyboard-focus:focus-visible:ring-2 keyboard-focus:focus-visible:ring-inset keyboard-focus:focus-visible:ring-ring"
                onDoubleClick={() => (zoom.kind === "fit" ? changeScale(1) : setZoom({ kind: "fit" }))}
                onKeyDown={(event) => {
                    if (event.key === "+" || event.key === "=") {
                        event.preventDefault();
                        changeScale(scale * 1.5);
                    }
                    if (event.key === "-") {
                        event.preventDefault();
                        changeScale(scale / 1.5);
                    }
                    if (event.key === "0") {
                        event.preventDefault();
                        setZoom({ kind: "fit" });
                    }
                }}
                onPointerDown={(event) => {
                    if (
                        event.button !== 0 ||
                        (event.target instanceof Element && event.target.closest("button, a") !== null)
                    ) {
                        return;
                    }
                    if (pointers.current.size === 0) {
                        gesture.current = {
                            moved: false,
                            background:
                                event.target === event.currentTarget ||
                                (event.target instanceof HTMLElement && event.target.dataset["imageBackground"] === ""),
                            multiple: false,
                            x: event.clientX,
                            y: event.clientY,
                        };
                    } else {
                        gesture.current.multiple = true;
                    }
                    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
                    event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                    const previous = pointers.current.get(event.pointerId);
                    if (previous === undefined) {
                        return;
                    }
                    const next = { x: event.clientX, y: event.clientY };
                    const other = [...pointers.current.entries()].find(([id]) => id !== event.pointerId)?.[1];
                    if (Math.abs(next.x - gesture.current.x) + Math.abs(next.y - gesture.current.y) > 4) {
                        gesture.current.moved = true;
                    }
                    if (other !== undefined) {
                        const before = Math.hypot(previous.x - other.x, previous.y - other.y);
                        if (before > 0) {
                            changeScale((scale * Math.hypot(next.x - other.x, next.y - other.y)) / before);
                        }
                        gesture.current.moved = true;
                    } else {
                        event.currentTarget.scrollLeft += previous.x - next.x;
                        event.currentTarget.scrollTop += previous.y - next.y;
                    }
                    pointers.current.set(event.pointerId, next);
                }}
                onPointerUp={(event) => {
                    pointers.current.delete(event.pointerId);
                    const dx = event.clientX - gesture.current.x;
                    const dy = event.clientY - gesture.current.y;
                    if (
                        event.pointerType === "touch" &&
                        zoom.kind === "fit" &&
                        !gesture.current.multiple &&
                        Math.abs(dx) > 60 &&
                        Math.abs(dx) > Math.abs(dy)
                    ) {
                        onStep?.(dx < 0 ? 1 : -1);
                    }
                    if (!gesture.current.moved && gesture.current.background && pointers.current.size === 0) {
                        onBackdrop?.();
                    }
                }}
                onPointerCancel={(event) => {
                    pointers.current.delete(event.pointerId);
                    gesture.current.moved = true;
                }}
                ref={onAttach}
                // biome-ignore lint/a11y/noNoninteractiveTabindex: the scrollable image canvas supports keyboard panning and zoom.
                tabIndex={0}
            >
                <div
                    className="flex min-h-full min-w-full items-center justify-center"
                    data-image-background=""
                    style={{ width: natural.width * scale, height: natural.height * scale }}
                    ref={(node) => {
                        if (node !== null && center.current !== null && surface.current !== null) {
                            surface.current.scrollLeft = center.current.left;
                            surface.current.scrollTop = center.current.top;
                            center.current = null;
                        }
                    }}
                >
                    {decoded.kind === "loading" && (
                        <span className="absolute text-sm text-muted-foreground" role="status">
                            Loading image…
                        </span>
                    )}
                    {decoded.kind === "failed" ? (
                        <div className="grid justify-items-center gap-3 p-6" role="alert">
                            <p>Couldn't display this image.</p>
                            <button
                                className={imageControlClass}
                                onClick={() => {
                                    setDecoded({ kind: "loading" });
                                    setAttempt(attempt + 1);
                                }}
                                type="button"
                            >
                                <RotateCw aria-hidden="true" className="size-4" />
                                Retry image
                            </button>
                        </div>
                    ) : (
                        <img
                            alt={image.name}
                            className="block shrink-0 select-none object-contain"
                            data-testid={testId}
                            draggable={false}
                            key={attempt}
                            onError={() => setDecoded({ kind: "failed" })}
                            onLoad={(event) =>
                                setDecoded({
                                    kind: "ready",
                                    size: {
                                        width: event.currentTarget.naturalWidth,
                                        height: event.currentTarget.naturalHeight,
                                    },
                                })
                            }
                            src={source}
                            style={{
                                width: decoded.kind === "ready" ? natural.width * scale : undefined,
                                height: decoded.kind === "ready" ? natural.height * scale : undefined,
                                maxWidth: "none",
                            }}
                        />
                    )}
                </div>
            </section>
        </div>
    );
}
