import { externalContentPath, type MobiusExternalContentBlock } from "@moxt-ai/mobius-sdk";
import { type ReactNode, useMemo } from "react";
import { dataTestId } from "../../data-testid.ts";
import { PreviewImage } from "../images/image-gallery.tsx";
import type { MarkdownImageReader } from "./agent-markdown.tsx";
import { isDisplayableImageType } from "./displayable-image-type.ts";
import type { SessionResourceRequest, SessionResourceState, SessionResourceStoreFactory } from "./resource-reader.ts";
import { SessionResource } from "./session-resource.tsx";

const SAFE_AUDIO_MIME = /^audio\/(?:aac|mpeg|mp4|ogg|wav|webm)$/u;

/**
 * Renders a Session's external content block through the injected reader and
 * the shared session-resource store: the store owns loading, cancellation,
 * and the object URL's lifetime through the ref-cleanup protocol, so this
 * component only maps resource state to presentation.
 */
export function ExternalContentBlock({
    content,
    createResourceStore,
    readContent,
    speaker,
}: {
    readonly content: MobiusExternalContentBlock;
    /** The view-model resource store factory that owns the load. */
    readonly createResourceStore: SessionResourceStoreFactory;
    readonly readContent?: MarkdownImageReader | undefined;
    readonly speaker: "assistant" | "user";
}) {
    const request = useMemo<SessionResourceRequest>(
        () => ({ path: externalContentPath(content), kind: requestKind(content) }),
        [content],
    );
    return (
        <SessionResource createStore={createResourceStore} inline request={request} read={readContent}>
            {(state) => renderContent(content, state, speaker)}
        </SessionResource>
    );
}

function requestKind(content: MobiusExternalContentBlock): SessionResourceRequest["kind"] {
    if (content.type === "external_resource" && content.encoding === "text") {
        return "text";
    }
    if (content.type === "external_image") {
        return "image";
    }
    if (content.type === "external_audio") {
        return "audio";
    }
    return "download";
}

function attachmentFileName(uri: string): string {
    const leaf = uri.split("/").pop() ?? "";
    try {
        const name = decodeURIComponent(leaf);
        return name.length > 0 ? name : "Download attachment";
    } catch {
        return leaf.length > 0 ? leaf : "Download attachment";
    }
}

function renderContent(
    content: MobiusExternalContentBlock,
    state: SessionResourceState,
    speaker: "assistant" | "user",
): ReactNode {
    if (state.kind === "loading") {
        return <p className="text-sm text-muted-foreground">Loading content…</p>;
    }
    if (state.kind === "failed") {
        return <p className="text-sm text-muted-foreground">Content could not be loaded.</p>;
    }
    switch (content.type) {
        case "external_image":
            return isDisplayableImageType(content.mimeType) && state.kind === "media" ? (
                <PreviewImage
                    alt={speaker === "user" ? "Your attachment" : "Agent-provided content"}
                    className={
                        speaker === "user"
                            ? "h-auto max-h-56 max-w-full rounded-lg object-contain object-left"
                            : "max-h-[480px] w-auto max-w-full rounded-xl border border-border object-contain"
                    }
                    data-testid={speaker === "user" ? dataTestId.userMessageImage : undefined}
                    blob={state.blob}
                    src={state.source}
                />
            ) : (
                <p className="text-sm text-muted-foreground">Image content could not be displayed safely.</p>
            );
        case "external_audio":
            return SAFE_AUDIO_MIME.test(content.mimeType) && state.kind === "media" ? (
                <audio controls src={state.source}>
                    <track kind="captions" />
                </audio>
            ) : (
                <p className="text-sm text-muted-foreground">Audio content could not be displayed safely.</p>
            );
        case "external_resource":
            return content.encoding === "text" && state.kind === "text" ? (
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs">
                    {state.text}
                </pre>
            ) : state.kind === "media" ? (
                <a
                    className="break-all text-sm underline"
                    download={attachmentFileName(content.uri)}
                    href={state.source}
                >
                    {attachmentFileName(content.uri)}
                </a>
            ) : (
                <p className="text-sm text-muted-foreground">Content could not be loaded.</p>
            );
    }
}
