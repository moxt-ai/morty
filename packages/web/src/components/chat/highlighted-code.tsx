import { AgentMarkdown } from "../agents/agent-markdown.tsx";

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
    bash: "bash",
    c: "c",
    cc: "cpp",
    cpp: "cpp",
    css: "css",
    go: "go",
    h: "c",
    hpp: "cpp",
    html: "html",
    java: "java",
    js: "javascript",
    json: "json",
    jsx: "jsx",
    md: "markdown",
    mdx: "mdx",
    py: "python",
    rb: "ruby",
    rs: "rust",
    sh: "bash",
    sql: "sql",
    toml: "toml",
    ts: "typescript",
    tsx: "tsx",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    zsh: "bash",
};

export function languageForPath(path: string): string {
    const normalized = path.split(/[?#]/u, 1)[0] ?? path;
    const extension = normalized.match(/\.([A-Za-z0-9]+)$/u)?.[1]?.toLowerCase();
    return extension === undefined ? "markdown" : (LANGUAGE_BY_EXTENSION[extension] ?? "markdown");
}

function fencedCode(code: string, language: string): string {
    const longestFence = Math.max(0, ...Array.from(code.matchAll(/`+/gu), (match) => match[0].length));
    const fence = "`".repeat(Math.max(3, longestFence + 1));
    return `${fence}${language}\n${code}\n${fence}`;
}

export function HighlightedCode({ code, language }: { readonly code: string; readonly language: string }) {
    return (
        <AgentMarkdown
            className="text-xs [&_pre]:m-0 [&_pre]:max-h-96 [&_pre]:overflow-auto [&_pre]:text-xs"
            markdown={fencedCode(code, language)}
            streaming={false}
        />
    );
}
