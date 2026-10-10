import type { MermaidConfig } from "@streamdown/mermaid";

export const MAX_MERMAID_CHARACTERS = 16 * 1024;

export const mermaidConfig: MermaidConfig = {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    htmlLabels: false,
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
