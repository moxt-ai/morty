import { createMermaidPlugin } from "@streamdown/mermaid";
import DOMPurify from "dompurify";
import { mermaidConfig } from "./mermaid-options.ts";

/** A sanitized Mermaid SVG sized to its own drawing, so each surface decides how large to show it. */
export type RenderedDiagram = {
    readonly height: number;
    readonly markup: string;
    readonly width: number;
};

const mermaid = createMermaidPlugin({ config: mermaidConfig }).getMermaid();
let renders = 0;

export async function renderMermaid(source: string): Promise<RenderedDiagram> {
    // Mermaid scopes each diagram's styles to this id, so every render needs its own.
    renders += 1;
    const { svg } = await mermaid.render(`morty-mermaid-${renders.toString()}`, source);
    // Mermaid strict mode still emits URL links. Diagram SVG bypasses Markdown's
    // link/image components, so keep it self-contained here.
    const fragment = DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ["a", "image", "foreignObject", "feImage"],
        // A URI regex also filters SVG coordinates and dimensions.
        // Remove link attributes without discarding diagram geometry.
        FORBID_ATTR: ["href", "xlink:href"],
        RETURN_DOM_FRAGMENT: true,
    });
    const element = fragment.firstElementChild;
    if (!(element instanceof SVGSVGElement)) {
        throw new Error("Mermaid did not produce an SVG diagram");
    }
    const [, , width, height] = (element.getAttribute("viewBox") ?? "")
        .trim()
        .split(/[\s,]+/u)
        .map(Number);
    if (width === undefined || height === undefined || !(width > 0) || !(height > 0)) {
        throw new Error("Mermaid produced a diagram without a size");
    }
    // Mermaid fills its container up to a max-width. Give the SVG its drawn size
    // instead; the inline figure and the fullscreen viewer each scale it.
    element.setAttribute("width", width.toString());
    element.setAttribute("height", height.toString());
    element.style.removeProperty("max-width");
    return { height, markup: element.outerHTML, width };
}
