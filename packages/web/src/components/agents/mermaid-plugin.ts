import { createMermaidPlugin, type DiagramPlugin } from "@streamdown/mermaid";
import DOMPurify from "dompurify";
import { mermaidConfig } from "./mermaid-options.ts";

const renderer = createMermaidPlugin({ config: mermaidConfig });

export const mermaidPlugin: DiagramPlugin = {
    name: "mermaid",
    type: "diagram",
    language: "mermaid",
    getMermaid: (config) => {
        const instance = renderer.getMermaid(config);
        return {
            initialize: instance.initialize,
            render: async (id, source) => {
                const { svg } = await instance.render(id, source);
                // Mermaid strict mode still emits URL links. Diagram SVG bypasses
                // Markdown's link/image components, so keep it self-contained here.
                return {
                    svg: DOMPurify.sanitize(svg, {
                        USE_PROFILES: { svg: true, svgFilters: true },
                        FORBID_TAGS: ["a", "image", "foreignObject", "feImage"],
                        ALLOWED_URI_REGEXP: /^#/u,
                    }),
                };
            },
        };
    },
};
