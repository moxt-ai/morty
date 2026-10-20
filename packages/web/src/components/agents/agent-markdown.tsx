import { Lexer } from "marked";
import { defaultRemarkPlugins, type MathPlugin, parseMarkdownIntoBlocks, Streamdown } from "streamdown";
import { isDisplayableImageType } from "../../services/chat/image-media-type.ts";
import "streamdown/styles.css";
import { type ComponentProps, useEffect, useMemo, useState } from "react";
import { dataTestId } from "@/data-testid";
import { cn } from "@/lib/utils";
import { boundedCodeHighlighter } from "./bounded-code-highlighter.ts";
import { MermaidCodeBlock } from "./mermaid-code-block.tsx";
import { remarkMermaidCompletion } from "./remark-mermaid-completion.ts";

const STREAMDOWN_CONTROLS = Object.freeze({
    code: Object.freeze({ copy: true, download: false }),
});
const STREAMDOWN_PLUGINS = Object.freeze({
    code: boundedCodeHighlighter,
    renderers: [{ language: "mermaid", component: MermaidCodeBlock }],
});
const STREAMDOWN_TRANSLATIONS = Object.freeze({ copyCode: "Copy code" });
const LOCAL_FILE_URL_ORIGIN = "https://local-file.morty.invalid";
const LATEX_DELIMITER_PATTERN = /(^|[^\\$])(?:\$\$[\s\S]+?\$\$|\$(?!\$)[^\n$]+\$)/u;
export const MAX_MARKDOWN_CHARACTERS = 32 * 1024;

function parseStreamingMarkdownIntoBlocks(markdown: string): string[] {
    const lexer = new Lexer({ gfm: true });
    lexer.blockTokens(markdown);
    return Object.keys(lexer.tokens.links).length > 0 ? [markdown] : parseMarkdownIntoBlocks(markdown);
}

function isSafeLink(href: string): boolean {
    return (
        href.startsWith("https://") || href.startsWith("http://") || href.startsWith("mailto:") || href.startsWith("#")
    );
}

function withoutSourceLocation(path: string): string {
    const value = path.replace(/:\d+(?::\d+)?$/u, "");
    return /^[A-Za-z]:[\\/]/u.test(value) ? value.replaceAll("/", "\\") : value;
}

function fileSystemPath(href: string): string | null {
    if (href.startsWith("file:")) {
        try {
            const url = new URL(href);
            if (url.protocol !== "file:" || url.host.length > 0) {
                return null;
            }
            const path = decodeURIComponent(url.pathname);
            return withoutSourceLocation(/^\/[A-Za-z]:\//u.test(path) ? path.slice(1) : path);
        } catch {
            return null;
        }
    }
    try {
        const decoded = decodeURI(href);
        return decoded.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(decoded) ? withoutSourceLocation(decoded) : null;
    } catch {
        return null;
    }
}

function relativeFilePath(href: string): string | null {
    try {
        const path = decodeURIComponent(href);
        return path.length > 0 && !/^(?:[a-z][a-z0-9+.-]*:|[\\/]|[?#])/iu.test(path) && !path.includes("\0")
            ? path
            : null;
    } catch {
        return null;
    }
}

function localFilePath(href: string): string | null {
    if (!href.startsWith(LOCAL_FILE_URL_ORIGIN)) {
        return fileSystemPath(href);
    }
    try {
        const url = new URL(href);
        const path = url.origin === LOCAL_FILE_URL_ORIGIN ? url.searchParams.get("path") : null;
        return path === null ? null : (fileSystemPath(path) ?? relativeFilePath(path));
    } catch {
        return null;
    }
}

function encodeLocalFileUrl(path: string): string {
    const url = new URL(LOCAL_FILE_URL_ORIGIN);
    url.searchParams.set("path", path);
    return url.href;
}

function rewriteLocalMarkdownTargets(value: unknown): void {
    if (typeof value !== "object" || value === null) {
        return;
    }
    if (
        "type" in value &&
        (value.type === "image" || value.type === "link") &&
        "url" in value &&
        typeof value.url === "string"
    ) {
        const path = localFilePath(value.url) ?? (value.type === "image" ? relativeFilePath(value.url) : null);
        if (path !== null) {
            value.url = encodeLocalFileUrl(path);
        }
    }
    if ("children" in value && Array.isArray(value.children)) {
        for (const child of value.children) {
            rewriteLocalMarkdownTargets(child);
        }
    }
}

function remarkLocalMarkdownTargets() {
    return rewriteLocalMarkdownTargets;
}

const STREAMDOWN_REMARK_PLUGINS = [...Object.values(defaultRemarkPlugins), remarkLocalMarkdownTargets];

function AgentMarkdownLink({
    children,
    href,
    openLocalFile,
}: ComponentProps<"a"> & { readonly openLocalFile?: ((path: string) => void) | undefined }) {
    const path = href === undefined ? null : localFilePath(href);
    if (path !== null && openLocalFile !== undefined) {
        return (
            <button
                className="cursor-pointer font-inherit font-medium text-[#19764a] underline decoration-[#2fb872]/35 underline-offset-2 hover:decoration-[#2fb872]"
                data-testid={dataTestId.localFileLink}
                onClick={() => openLocalFile(path)}
                type="button"
            >
                {children}
            </button>
        );
    }
    if (href === undefined || !isSafeLink(href)) {
        return <span>{children}</span>;
    }
    return (
        <a href={href} rel="noopener noreferrer" target="_blank">
            {children}
        </a>
    );
}

export type MarkdownImageReader = (
    path: string,
    signal: AbortSignal,
) => Promise<{ readonly bytes: Uint8Array; readonly mediaType: string }>;

function directImageSource(value: string): string {
    if (localFilePath(value) !== null) {
        return "";
    }
    if (value.startsWith("https://") || value.startsWith("http://") || value.startsWith("data:image/")) {
        return value;
    }
    return "";
}

function AgentMarkdownImage({
    alt,
    className,
    readImage,
    src,
    title,
}: ComponentProps<"img"> & {
    readonly readImage?: MarkdownImageReader | undefined;
}) {
    const directSource = typeof src === "string" ? directImageSource(src) : "";
    const requestedSource = typeof src === "string" ? (localFilePath(src) ?? src) : "";
    const [source, setSource] = useState<string | null>(directSource || null);

    useEffect(() => {
        if (directSource.length > 0) {
            setSource(directSource);
            return;
        }
        if (requestedSource.length === 0 || readImage === undefined) {
            setSource("");
            return;
        }
        const controller = new AbortController();
        let objectUrl = "";
        setSource(null);
        void readImage(requestedSource, controller.signal)
            .then((file) => {
                if (controller.signal.aborted) {
                    return;
                }
                if (!isDisplayableImageType(file.mediaType)) {
                    setSource("");
                    return;
                }
                objectUrl = URL.createObjectURL(new Blob([Uint8Array.from(file.bytes)], { type: file.mediaType }));
                setSource(objectUrl);
            })
            .catch(() => {
                if (!controller.signal.aborted) {
                    setSource("");
                }
            });
        return () => {
            controller.abort();
            if (objectUrl.length > 0) {
                URL.revokeObjectURL(objectUrl);
            }
        };
    }, [directSource, readImage, requestedSource]);

    if (source === null) {
        return <span className="text-xs text-muted-foreground">Loading image…</span>;
    }
    if (source.length === 0) {
        return <span className="text-xs text-muted-foreground">Image not available</span>;
    }
    return <img alt={alt ?? ""} className={className} loading="lazy" src={source} title={title} />;
}

export interface AgentMarkdownProps {
    readonly className?: string;
    readonly markdown: string;
    readonly openLocalFile?: ((path: string) => void) | undefined;
    readonly readImage?: MarkdownImageReader | undefined;
    readonly sourceCharacters?: number | undefined;
    readonly streaming: boolean;
}

interface AgentMarkdownContentProps extends AgentMarkdownProps {
    readonly mathPlugin?: MathPlugin | undefined;
}

export function AgentMarkdownContent({
    className,
    markdown,
    mathPlugin,
    openLocalFile,
    readImage,
    sourceCharacters = markdown.length,
    streaming,
}: AgentMarkdownContentProps) {
    const remarkPlugins = useMemo(() => {
        // Explicit options also distinguish Streamdown's cached parser configurations.
        const completion: [typeof remarkMermaidCompletion, { readonly streaming: boolean }] = [
            remarkMermaidCompletion,
            { streaming },
        ];
        return [completion, ...STREAMDOWN_REMARK_PLUGINS];
    }, [streaming]);
    const components = useMemo(
        () => ({
            a: (properties: ComponentProps<"a">) => <AgentMarkdownLink {...properties} openLocalFile={openLocalFile} />,
            img: (properties: ComponentProps<"img">) => <AgentMarkdownImage {...properties} readImage={readImage} />,
        }),
        [openLocalFile, readImage],
    );
    const plugins = useMemo(
        () => (mathPlugin === undefined ? STREAMDOWN_PLUGINS : { ...STREAMDOWN_PLUGINS, math: mathPlugin }),
        [mathPlugin],
    );
    return sourceCharacters > MAX_MARKDOWN_CHARACTERS ? (
        <pre
            className={cn(
                "m-0 min-w-0 whitespace-pre-wrap break-words font-sans text-[15px] leading-6 text-foreground",
                className,
            )}
        >
            {markdown}
        </pre>
    ) : (
        <Streamdown
            className={cn(
                "agent-markdown min-w-0 text-[15px] leading-6 text-foreground [overflow-wrap:anywhere]",
                "[&_p]:my-2 [&_p]:whitespace-pre-line",
                "[&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:text-[21px] [&_h1]:leading-7 [&_h1]:font-semibold md:[&_h1]:mt-7 md:[&_h1]:text-2xl md:[&_h1]:leading-8",
                "[&_h2]:mt-5 [&_h2]:mb-3 [&_h2]:text-lg [&_h2]:leading-7 [&_h2]:font-semibold md:[&_h2]:mt-6 md:[&_h2]:text-xl",
                "[&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:text-base [&_h3]:leading-6 [&_h3]:font-semibold",
                "[&_h4]:mt-4 [&_h4]:mb-2 [&_h4]:font-semibold",
                "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5",
                "[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5",
                "[&_li>p]:my-0",
                "[&_blockquote]:my-3 [&_blockquote]:border-l-[3px] [&_blockquote]:border-black/12 [&_blockquote]:pl-3 [&_blockquote]:text-[#454959]",
                "[&_a]:font-medium [&_a]:text-[#19764a] [&_a]:underline [&_a]:decoration-[#2fb872]/35 [&_a]:underline-offset-2 hover:[&_a]:decoration-[#2fb872]",
                "[&_code]:font-mono",
                "[&_table]:text-sm",
                className,
            )}
            components={components}
            controls={STREAMDOWN_CONTROLS}
            isAnimating={streaming}
            lineNumbers={false}
            mode={streaming ? "streaming" : "static"}
            parseMarkdownIntoBlocksFn={parseStreamingMarkdownIntoBlocks}
            plugins={plugins}
            remarkPlugins={remarkPlugins}
            translations={STREAMDOWN_TRANSLATIONS}
        >
            {markdown}
        </Streamdown>
    );
}

export function AgentMarkdown(properties: AgentMarkdownProps) {
    const sourceCharacters = properties.sourceCharacters ?? properties.markdown.length;
    if (sourceCharacters > MAX_MARKDOWN_CHARACTERS || !LATEX_DELIMITER_PATTERN.test(properties.markdown)) {
        return <AgentMarkdownContent {...properties} />;
    }
    return <AgentMarkdownWithLatexWhenReady {...properties} />;
}

type LatexRenderer = typeof import("./agent-markdown-with-latex.tsx")["AgentMarkdownWithLatex"];
let latexRenderer: Promise<LatexRenderer> | null = null;

/**
 * Loads the LaTeX renderer as an explicit state transition. The Suspense
 * fallback swap can drop the resolved component's DOM commit under load,
 * which leaves the interim non-math render stuck; rendering from resolved
 * state commits deterministically.
 */
export function loadLatexRenderer(): Promise<LatexRenderer> {
    latexRenderer ??= import("./agent-markdown-with-latex.tsx").then(
        (module) => module.AgentMarkdownWithLatex,
        // A failed chunk import degrades to the non-math render instead of an
        // unhandled rejection; consumers render markdown either way.
        () => AgentMarkdownContent,
    );
    return latexRenderer;
}

function AgentMarkdownWithLatexWhenReady(properties: AgentMarkdownProps) {
    const [renderer, setRenderer] = useState<LatexRenderer | null>(null);
    useEffect(() => {
        let active = true;
        void loadLatexRenderer().then((component) => {
            if (active) {
                setRenderer(() => component);
            }
        });
        return () => {
            active = false;
        };
    }, []);
    if (renderer === null) {
        return <AgentMarkdownContent {...properties} />;
    }
    const Latex = renderer;
    return <Latex {...properties} />;
}
