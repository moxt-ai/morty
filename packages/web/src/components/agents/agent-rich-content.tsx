import type { AgentDisplayContent } from "@moxt-ai/mobius-sdk";
import { ExternalLink, FileText, Image as ImageIcon, Terminal, Video } from "lucide-react";
import { useEffect, useState } from "react";
import type { MarkdownImageReader } from "@/components/agents/agent-markdown";
import { AgentMarkdown } from "@/components/agents/agent-markdown";

const SAFE_IMAGE_MIME = /^image\/(?:gif|jpeg|png|webp)$/;
const SAFE_VIDEO_MIME = /^video\/(?:mp4|webm)$/;

function safeLink(value: string): string {
    try {
        const url = new URL(value);
        if (url.protocol === "https:" || url.protocol === "http:") {
            return url.toString();
        }
    } catch {}
    return "";
}

function ContentHeader({ content }: { readonly content: AgentDisplayContent }) {
    const label = content.name || content.path || content.uri || content.type;
    return (
        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.04em] text-[#7d8590] uppercase">
            {content.type === "image" ? (
                <ImageIcon className="size-3" />
            ) : content.type === "video" ? (
                <Video className="size-3" />
            ) : content.type === "terminal" ? (
                <Terminal className="size-3" />
            ) : (
                <FileText className="size-3" />
            )}
            <span className="truncate normal-case tracking-normal" title={label}>
                {label}
            </span>
        </div>
    );
}

function LocalImage({
    content,
    mediaTestId,
    readImage,
}: {
    readonly content: AgentDisplayContent;
    readonly mediaTestId?: string | undefined;
    readonly readImage?: MarkdownImageReader | undefined;
}) {
    const [source, setSource] = useState<string | null>(null);
    useEffect(() => {
        const controller = new AbortController();
        let objectUrl = "";
        const load = async () => {
            try {
                if (readImage === undefined) {
                    setSource("");
                    return;
                }
                const file = await readImage(content.uri, controller.signal);

                if (controller.signal.aborted || !SAFE_IMAGE_MIME.test(file.mediaType)) {
                    return;
                }
                objectUrl = URL.createObjectURL(new Blob([Uint8Array.from(file.bytes)], { type: file.mediaType }));
                setSource(objectUrl);
            } catch (error: unknown) {
                if (!controller.signal.aborted) {
                    console.error("Agent media could not be loaded", error);
                    setSource("");
                }
            }
        };
        void load();
        return () => {
            controller.abort();
            if (objectUrl.length > 0) {
                URL.revokeObjectURL(objectUrl);
            }
        };
    }, [content.uri, readImage]);
    if (source === null) {
        return (
            <div className="min-h-24 rounded-lg border-[0.5px] border-black/8 bg-black/[0.02] p-3 text-xs text-muted-foreground">
                Loading media…
            </div>
        );
    }
    if (source.length === 0) {
        return (
            <div className="rounded-lg border-[0.5px] border-black/8 bg-black/[0.02] p-3 text-xs text-muted-foreground">
                Media content could not be loaded.
            </div>
        );
    }
    return (
        <figure className="m-0 overflow-hidden rounded-xl border-[0.5px] border-black/9 bg-white p-2">
            <ContentHeader content={content} />
            <img
                alt={content.name.length > 0 ? content.name : "Agent-provided image"}
                className="max-h-[480px] w-auto max-w-full rounded-lg object-contain"
                data-testid={mediaTestId}
                loading="lazy"
                src={source}
            />
        </figure>
    );
}

function AgentRichContentItem({
    content,
    mediaTestId,
    openLocalFile,
    readImage,
}: {
    readonly content: AgentDisplayContent;
    readonly mediaTestId?: string | undefined;
    readonly readImage?: MarkdownImageReader | undefined;
    readonly openLocalFile?: ((path: string) => void) | undefined;
}) {
    if (content.type === "image" && content.uri.length > 0) {
        if (readImage !== undefined) {
            return <LocalImage content={content} mediaTestId={mediaTestId} readImage={readImage} />;
        }
        return (
            <div className="rounded-lg border-[0.5px] border-black/8 bg-black/[0.02] p-3 text-xs text-muted-foreground">
                Media content could not be loaded.
            </div>
        );
    }
    if (content.type === "image" || content.type === "video") {
        const safeMime = content.type === "image" ? SAFE_IMAGE_MIME : SAFE_VIDEO_MIME;
        if (!safeMime.test(content.mimeType) || content.data.length === 0) {
            return (
                <div className="rounded-lg border-[0.5px] border-black/8 bg-black/[0.02] p-3 text-xs text-muted-foreground">
                    Media content could not be displayed safely.
                </div>
            );
        }
        if (content.type === "video") {
            return (
                <figure className="m-0 overflow-hidden rounded-xl border-[0.5px] border-black/9 bg-white p-2">
                    <ContentHeader content={content} />
                    <video
                        aria-label={content.name.length > 0 ? content.name : "Agent-provided video"}
                        className="max-h-[480px] w-auto max-w-full rounded-lg bg-black object-contain"
                        controls
                        data-testid={mediaTestId}
                        muted
                        playsInline
                        preload="metadata"
                        src={`data:${content.mimeType};base64,${content.data}`}
                    />
                </figure>
            );
        }
        return (
            <figure className="m-0 overflow-hidden rounded-xl border-[0.5px] border-black/9 bg-white p-2">
                <ContentHeader content={content} />
                <img
                    alt={content.name.length > 0 ? content.name : "Agent-provided image"}
                    className="max-h-[480px] w-auto max-w-full rounded-lg object-contain"
                    data-testid={mediaTestId}
                    loading="lazy"
                    src={`data:${content.mimeType};base64,${content.data}`}
                />
            </figure>
        );
    }
    if (content.type === "diff") {
        return (
            <section className="overflow-hidden rounded-xl border-[0.5px] border-black/9 bg-white">
                <div className="border-b-[0.5px] border-black/7 px-3 pt-2">
                    <ContentHeader content={content} />
                </div>
                <div className="grid max-h-96 overflow-auto font-mono text-[11px] leading-[18px] md:grid-cols-2">
                    <pre className="m-0 whitespace-pre-wrap bg-[#fff4f2] p-3 text-[#8f2f35]">{content.oldText}</pre>
                    <pre className="m-0 whitespace-pre-wrap bg-[#effaf4] p-3 text-[#17663f]">{content.newText}</pre>
                </div>
            </section>
        );
    }
    if (content.type === "resource_link") {
        const href = safeLink(content.uri);
        return (
            <div className="rounded-lg border-[0.5px] border-black/9 bg-white p-3">
                <ContentHeader content={content} />
                {href.length > 0 ? (
                    <a
                        className="inline-flex min-h-11 items-center gap-1.5 break-all text-xs font-medium text-success underline decoration-primary/40 underline-offset-2 hover:decoration-success focus-visible:ring-2 focus-visible:ring-ring/70 md:min-h-9"
                        href={href}
                        rel="noreferrer"
                        target="_blank"
                    >
                        {content.text.length > 0 ? content.text : href}
                        <ExternalLink className="size-3 shrink-0" />
                    </a>
                ) : (
                    <code className="break-all text-[11px] text-muted-foreground">{content.uri}</code>
                )}
            </div>
        );
    }
    if (content.type === "terminal") {
        return (
            <section className="overflow-hidden rounded-xl border-[0.5px] border-black/9 bg-[#17191d] text-[#e6e8eb]">
                <div className="px-3 pt-2 text-[#aeb5bc]">
                    <ContentHeader content={content} />
                </div>
                <pre className="m-0 max-h-80 overflow-auto px-3 pb-3 font-mono text-[11px] leading-[18px] whitespace-pre-wrap">
                    {content.text}
                </pre>
            </section>
        );
    }
    if (content.type === "text") {
        return (
            <div className="rounded-lg border-[0.5px] border-black/8 bg-white px-3 py-2">
                <AgentMarkdown markdown={content.text} openLocalFile={openLocalFile} streaming={false} />
            </div>
        );
    }
    return (
        <section className="rounded-xl border-[0.5px] border-black/9 bg-white p-3">
            <ContentHeader content={content} />
            {content.text.length > 0 && (
                <pre className="m-0 max-h-80 overflow-auto font-mono text-[11px] leading-[18px] whitespace-pre-wrap text-[#555c68]">
                    {content.text}
                </pre>
            )}
            {content.uri.length > 0 && (
                <code className="mt-2 block break-all text-[10px] text-muted-foreground">{content.uri}</code>
            )}
        </section>
    );
}

export function AgentRichContent({
    contents,
    mediaTestId,
    readImage,
    openLocalFile,
}: {
    readonly contents: readonly AgentDisplayContent[];
    readonly mediaTestId?: string | undefined;
    readonly readImage?: MarkdownImageReader | undefined;
    readonly openLocalFile?: ((path: string) => void) | undefined;
}) {
    if (contents.length === 0) {
        return null;
    }
    return (
        <div className="mt-2 grid gap-2">
            {contents.map((content, index) => (
                <AgentRichContentItem
                    content={content}
                    key={`${content.type}:${content.name}:${content.uri}:${index.toString()}`}
                    mediaTestId={mediaTestId}
                    readImage={readImage}
                    openLocalFile={openLocalFile}
                />
            ))}
        </div>
    );
}
