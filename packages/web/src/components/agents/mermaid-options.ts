import type { MermaidConfig } from "@streamdown/mermaid";

export const MAX_MERMAID_CHARACTERS = 16 * 1024;

export const mermaidConfig: MermaidConfig = {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    htmlLabels: false,
    theme: "neutral",
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    themeVariables: {
        fontSize: "16px",
    },
    // Mermaid scopes these rules to each SVG. Keep colors as CSS variables so
    // inline and portalled fullscreen diagrams inherit the live Morty theme.
    // Explicit diagram class/style directives retain their higher priority.
    themeCSS: `
        .node rect, .node circle, .node ellipse, .node polygon, .node path,
        rect.actor, .labelBox {
            fill: var(--surface-elevated);
            stroke: var(--border);
            stroke-width: 1px;
        }
        .node rect, rect.actor, .labelBox, .cluster rect {
            rx: var(--radius-sm);
            ry: var(--radius-sm);
        }
        .cluster rect {
            fill: var(--muted);
            stroke: var(--border);
        }
        .label, .label text, .node .label, .node .label text,
        text, .nodeLabel, .nodeLabel p, .cluster-label text,
        text.actor, .messageText, .labelText, .loopText, .noteText {
            fill: var(--foreground);
            color: var(--foreground);
        }
        .flowchart-link, .messageLine0, .messageLine1 {
            stroke: var(--morty-text-3);
            stroke-width: 1.5px;
        }
        .marker, .arrowheadPath, .arrowMarkerPath, #arrowhead path {
            fill: var(--morty-text-3);
            stroke: var(--morty-text-3);
        }
        .actor-line, .loopLine {
            stroke: var(--border);
        }
        .edgeLabel, .edgeLabel p, .edgeLabel rect, .labelBkg {
            background-color: var(--surface-subtle);
            fill: var(--surface-subtle);
        }
        .note, .activation0, .activation1, .activation2 {
            fill: var(--primary-subtle);
            stroke: var(--primary);
        }
    `,
    flowchart: {
        curve: "rounded",
        nodeSpacing: 32,
        rankSpacing: 48,
        padding: 16,
    },
    maxTextSize: MAX_MERMAID_CHARACTERS,
    maxEdges: 500,
    // Preserve Mermaid's protected defaults and prevent diagram-level HTML overrides.
    secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "suppressErrorRendering",
        "maxEdges",
        "htmlLabels",
        "dompurifyConfig",
        "themeCSS",
        "themeVariables",
    ],
};
