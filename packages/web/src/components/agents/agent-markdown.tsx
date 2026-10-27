import { Check, Copy } from "lucide-react";
import { Lexer } from "marked";
import {
    defaultRehypePlugins,
    defaultRemarkPlugins,
    type MathPlugin,
    parseMarkdownIntoBlocks,
    Streamdown,
} from "streamdown";
import { ImageGallery, PreviewImage } from "../images/image-gallery.tsx";
import "streamdown/styles.css";
import { type ComponentProps, createContext, type SVGProps, useContext, useEffect, useMemo, useState } from "react";
import { dataTestId } from "@/data-testid";
import { cn } from "@/lib/utils";
import { boundedCodeHighlighter } from "../../components/agents/bounded-code-highlighter.ts";
import { MermaidCodeBlock } from "../../components/agents/mermaid-code-block.tsx";
import { remarkMermaidCompletion } from "../../components/agents/remark-mermaid-completion.ts";
import type { SessionResourceReader as MarkdownImageReader, SessionResourceStoreFactory } from "./resource-reader.ts";
import { SessionResource } from "./session-resource.tsx";

export type { SessionResourceReader as MarkdownImageReader } from "./resource-reader.ts";

const STREAMDOWN_CONTROLS = Object.freeze({
    code: Object.freeze({ copy: true, download: false }),
});
const STREAMDOWN_PLUGINS = Object.freeze({
    code: boundedCodeHighlighter,
    renderers: [{ language: "mermaid", component: MermaidCodeBlock }],
});
const STREAMDOWN_TRANSLATIONS = Object.freeze({ copyCode: "Copy code" });
// Tags render as literal text, so incomplete tags must remain visible while streaming.
const STREAMDOWN_REMEND = Object.freeze({ htmlTags: false });
// Without the raw-HTML parser, Streamdown preserves HTML nodes as literal text.
// Keep sanitization and URL hardening for the elements produced by Markdown.
const STREAMDOWN_REHYPE_PLUGINS = Object.entries(defaultRehypePlugins)
    .filter(([name]) => name !== "raw")
    .map(([, plugin]) => plugin);

type StreamdownIconProps = SVGProps<SVGSVGElement> & { readonly size?: number };

function StreamdownCopyIcon({ className, size: _size, ...props }: StreamdownIconProps) {
    return <Copy aria-hidden="true" className={cn("size-3.5", className)} {...props} />;
}

function StreamdownCheckIcon({ className, size: _size, ...props }: StreamdownIconProps) {
    return <Check aria-hidden="true" className={cn("size-3.5", className)} {...props} />;
}

const STREAMDOWN_ICONS = Object.freeze({
    CheckIcon: StreamdownCheckIcon,
    CopyIcon: StreamdownCopyIcon,
});

const STREAMDOWN_FENCED_CODE_BLOCK_CLASSES = [
    "[&_[data-streamdown=code-block]]:!overflow-hidden",
    "[&_[data-streamdown=code-block]]:rounded-[16px]",
    "[&_[data-streamdown=code-block]]:!border-0",
    "[&_[data-streamdown=code-block]]:!bg-muted",
    "[&_[data-streamdown=code-block-header]]:!h-6",
    "[&_[data-streamdown=code-block-body]]:flex [&_[data-streamdown=code-block-body]]:min-h-0 [&_[data-streamdown=code-block-body]]:flex-col [&_[data-streamdown=code-block-body]]:!overflow-hidden",
    "[&_[data-streamdown=code-block-body]]:!border-0",
    "[&_[data-streamdown=code-block-body]]:!bg-background",
    "[&_[data-streamdown=code-block-body]]:!p-3",
    "[&_[data-streamdown=code-block-body]]:!text-[13px]",
    "[&_[data-streamdown=code-block-body]_pre]:min-h-0 [&_[data-streamdown=code-block-body]_pre]:flex-1 [&_[data-streamdown=code-block-body]_pre]:overflow-auto",
    "[&_[data-streamdown=code-block-actions]]:!border-0",
    "[&_[data-streamdown=code-block-actions]]:!bg-transparent",
    "[&_[data-streamdown=code-block-actions]]:shadow-none",
    "[&_[data-streamdown=code-block-actions]]:backdrop-blur-none",
    "[&_[data-streamdown=code-block-actions]]:supports-[backdrop-filter]:!bg-transparent",
    "[&_[data-streamdown=code-block-actions]]:!p-0",
    "[&_[data-streamdown=code-block-copy-button]]:flex",
    "[&_[data-streamdown=code-block-copy-button]]:size-6",
    "[&_[data-streamdown=code-block-copy-button]]:items-center",
    "[&_[data-streamdown=code-block-copy-button]]:justify-center",
    "[&_[data-streamdown=code-block-copy-button]]:rounded-md",
    "[&_[data-streamdown=code-block-copy-button]]:!p-0",
    "[&_[data-streamdown=code-block-copy-button]]:text-muted-foreground",
    "[&_[data-streamdown=code-block-copy-button]]:transition-opacity",
    "[&_[data-streamdown=code-block-copy-button]]:hover:bg-black/[0.045]",
    "[&_[data-streamdown=code-block-copy-button]]:hover:text-foreground",
    "[&_[data-streamdown=code-block-copy-button]]:keyboard-focus:focus-visible:ring-[3px]",
    "[&_[data-streamdown=code-block-copy-button]]:keyboard-focus:focus-visible:ring-ring/60",
    "[&_[data-streamdown=code-block-copy-button]_svg]:size-3.5",
    "[&_[data-streamdown=inline-code]]:text-[13px] [&_[data-streamdown=inline-code]]:text-copy-secondary",
].join(" ");
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
        // Relative targets refer to files in the session working directory for
        // both links and images, so rewrite them before URL hardening can see a
        // bare relative URL and replace the node with a blocked marker.
        const path = localFilePath(value.url) ?? relativeFilePath(value.url);
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

const MarkdownResources = createContext<
    Pick<AgentMarkdownProps, "openLocalFile" | "createResourceStore" | "readImage">
>({});

function AgentMarkdownLink({ children, href }: ComponentProps<"a">) {
    const { openLocalFile } = useContext(MarkdownResources);
    const path = href === undefined ? null : localFilePath(href);
    if (path !== null && openLocalFile !== undefined) {
        return (
            <button
                className="cursor-pointer font-inherit font-medium text-primary underline decoration-primary/35 underline-offset-2 hover:text-primary-hover hover:decoration-primary active:text-primary-active"
                data-testid={dataTestId.localFileLink}
                onClick={(event) => {
                    // Preserve a return-focus target even on browsers that do not focus tapped buttons.
                    event.currentTarget.focus({ preventScroll: true });
                    openLocalFile(path);
                }}
                type="button"
            >
                {children}
            </button>
        );
    }
    // A local file reference without an opener stays plain text: the rewritten
    // placeholder URL has no destination a browser could visit.
    if (href === undefined || path !== null || !isSafeLink(href)) {
        return <span>{children}</span>;
    }
    return (
        <a href={href} rel="noopener noreferrer" target="_blank">
            {children}
        </a>
    );
}

function directImageSource(value: string): string {
    if (localFilePath(value) !== null) {
        return "";
    }
    if (value.startsWith("https://") || value.startsWith("http://") || value.startsWith("data:image/")) {
        return value;
    }
    return "";
}

function AgentMarkdownImage({ alt, className, src, title }: ComponentProps<"img">) {
    const { createResourceStore, readImage } = useContext(MarkdownResources);
    const directSource = typeof src === "string" ? directImageSource(src) : "";
    const requestedSource = typeof src === "string" ? (localFilePath(src) ?? src) : "";
    if (directSource.length > 0) {
        return <PreviewImage alt={alt ?? ""} className={className} loading="lazy" src={directSource} title={title} />;
    }
    if (createResourceStore === undefined || readImage === undefined) {
        return <span className="text-xs text-muted-foreground">Image not available</span>;
    }
    return (
        <SessionResource
            inline
            createStore={createResourceStore}
            request={{ kind: "image", path: requestedSource }}
            read={readImage}
        >
            {(state) => {
                if (state.kind === "loading") {
                    return <span className="text-xs text-muted-foreground">Loading image…</span>;
                }
                if (state.kind !== "media") {
                    return <span className="text-xs text-muted-foreground">Image not available</span>;
                }
                return (
                    <PreviewImage
                        alt={alt ?? ""}
                        className={className}
                        loading="lazy"
                        blob={state.blob}
                        src={state.source}
                        title={title}
                    />
                );
            }}
        </SessionResource>
    );
}

export interface AgentMarkdownProps {
    readonly className?: string;
    /** The view-model resource store factory; without it remote images render as unavailable. */
    readonly createResourceStore?: SessionResourceStoreFactory | undefined;
    readonly markdown: string;
    readonly openLocalFile?: ((path: string) => void) | undefined;
    readonly readImage?: MarkdownImageReader | undefined;
    readonly sourceCharacters?: number | undefined;
    readonly streaming: boolean;
}

// Renderer identities must survive parent updates, including updates between
// pointer-down and click. Context supplies the latest callbacks without remounts.
const STREAMDOWN_COMPONENTS = { a: AgentMarkdownLink, img: AgentMarkdownImage };

interface AgentMarkdownContentProps extends AgentMarkdownProps {
    readonly mathPlugin?: MathPlugin | undefined;
}

export function AgentMarkdownContent({
    className,
    createResourceStore,
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
    const resources = useMemo(
        () => ({ openLocalFile, readImage, createResourceStore }),
        [openLocalFile, readImage, createResourceStore],
    );
    const plugins = useMemo(
        () => (mathPlugin === undefined ? STREAMDOWN_PLUGINS : { ...STREAMDOWN_PLUGINS, math: mathPlugin }),
        [mathPlugin],
    );
    return sourceCharacters > MAX_MARKDOWN_CHARACTERS ? (
        <pre
            className={cn(
                "m-0 min-w-0 whitespace-pre-wrap break-words font-sans text-base leading-6 text-foreground",
                className,
            )}
        >
            {markdown}
        </pre>
    ) : (
        <MarkdownResources value={resources}>
            <Streamdown
                className={cn(
                    "agent-markdown min-w-0 text-base leading-6 text-foreground [overflow-wrap:anywhere]",
                    "[&_p]:my-2 [&_p]:whitespace-pre-line",
                    "[&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:text-[21px] [&_h1]:leading-7 [&_h1]:font-semibold md:[&_h1]:mt-7 md:[&_h1]:text-2xl md:[&_h1]:leading-8",
                    "[&_h2]:mt-5 [&_h2]:mb-3 [&_h2]:text-lg [&_h2]:leading-7 [&_h2]:font-semibold md:[&_h2]:mt-6 md:[&_h2]:text-xl",
                    "[&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:text-base [&_h3]:leading-6 [&_h3]:font-semibold",
                    "[&_h4]:mt-4 [&_h4]:mb-2 [&_h4]:font-semibold",
                    "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5",
                    "[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5",
                    "[&_li>p]:my-0",
                    "[&_blockquote]:my-3 [&_blockquote]:border-l-[3px] [&_blockquote]:border-black/12 [&_blockquote]:pl-3 [&_blockquote]:text-[#454959]",
                    "[&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_a]:decoration-primary/35 [&_a]:underline-offset-2 [&_a]:transition-colors hover:[&_a]:text-primary-hover hover:[&_a]:decoration-primary active:[&_a]:text-primary-active",
                    "[&_code]:font-mono",
                    "[&_table]:text-sm",
                    STREAMDOWN_FENCED_CODE_BLOCK_CLASSES,
                    className,
                )}
                components={STREAMDOWN_COMPONENTS}
                controls={STREAMDOWN_CONTROLS}
                icons={STREAMDOWN_ICONS}
                isAnimating={streaming}
                lineNumbers={false}
                // Keep the same block tree when a turn completes, including between pointer down and click.
                mode="streaming"
                parseIncompleteMarkdown={streaming}
                parseMarkdownIntoBlocksFn={parseStreamingMarkdownIntoBlocks}
                plugins={plugins}
                rehypePlugins={STREAMDOWN_REHYPE_PLUGINS}
                remarkPlugins={remarkPlugins}
                remend={STREAMDOWN_REMEND}
                translations={STREAMDOWN_TRANSLATIONS}
            >
                {markdown}
            </Streamdown>
        </MarkdownResources>
    );
}

export function AgentMarkdown(properties: AgentMarkdownProps) {
    const sourceCharacters = properties.sourceCharacters ?? properties.markdown.length;
    return (
        <ImageGallery>
            {sourceCharacters > MAX_MARKDOWN_CHARACTERS || !LATEX_DELIMITER_PATTERN.test(properties.markdown) ? (
                <AgentMarkdownContent {...properties} />
            ) : (
                <AgentMarkdownWithLatexWhenReady {...properties} />
            )}
        </ImageGallery>
    );
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
