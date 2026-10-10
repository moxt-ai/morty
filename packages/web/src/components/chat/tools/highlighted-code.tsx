import { cn } from "@/lib/utils";
import { AgentMarkdown, MAX_MARKDOWN_CHARACTERS } from "../../agents/agent-markdown.tsx";
import { ToolTextPreview } from "./tool-text-preview.tsx";

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

export function HighlightedCode({
    bare = false,
    code,
    language,
}: {
    readonly bare?: boolean;
    readonly code: string;
    readonly language: string;
}) {
    if (code.length > MAX_MARKDOWN_CHARACTERS) {
        return <ToolTextPreview className={cn("p-4 text-xs", bare && "max-h-none")} text={code} />;
    }
    return (
        <AgentMarkdown
            className={cn(
                "text-xs [&_pre]:m-0 [&_pre]:max-h-96 [&_pre]:overflow-auto [&_pre]:text-xs",
                bare &&
                    "[&_[data-streamdown=code-block]]:m-0 [&_[data-streamdown=code-block]]:gap-0 [&_[data-streamdown=code-block]]:rounded-none [&_[data-streamdown=code-block]]:border-0 [&_[data-streamdown=code-block]]:bg-transparent [&_[data-streamdown=code-block]]:p-0 [&_[data-streamdown=code-block-header]]:hidden [&_[data-streamdown=code-block-actions]]:hidden [&_[data-streamdown=code-block-body]]:!max-h-none [&_[data-streamdown=code-block-body]]:rounded-none [&_[data-streamdown=code-block-body]]:border-0 [&_[data-streamdown=code-block-body]]:bg-transparent [&_[data-streamdown=code-block-body]]:p-4",
            )}
            markdown={fencedCode(code, language)}
            streaming={false}
        />
    );
}
