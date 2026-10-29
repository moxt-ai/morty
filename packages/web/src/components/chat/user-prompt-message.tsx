import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { MessageBubble } from "../../components/chat/message-bubble.tsx";
import { UserMessageShell } from "../../components/chat/user-message-shell.tsx";
import { dataTestId } from "../../data-testid.ts";
import { AgentMarkdown } from "../agents/agent-markdown.tsx";
import { ImageGallery, PreviewImage } from "../images/image-gallery.tsx";
import type { ComposerAttachment } from "./composer-attachment.ts";

interface UserPromptMessageProps {
    readonly attachments: readonly ComposerAttachment[];
    readonly text: string;
}

function PromptImage({ attachment }: { readonly attachment: ComposerAttachment }) {
    const [source, setSource] = useState("");
    useEffect(() => {
        const url = URL.createObjectURL(new Blob([attachment.bytes.slice().buffer], { type: attachment.mediaType }));
        setSource(url);
        return () => URL.revokeObjectURL(url);
    }, [attachment]);
    return source.length === 0 ? null : (
        <PreviewImage
            alt={attachment.name}
            className="h-auto max-h-56 max-w-full rounded-lg object-contain object-left"
            loading="lazy"
            src={source}
        />
    );
}

export function UserPromptMessage({ attachments, text }: UserPromptMessageProps) {
    if (text.length === 0 && attachments.length === 0) {
        return null;
    }
    const images = attachments.filter((attachment) => attachment.kind === "image");
    const resources = attachments.filter((attachment) => attachment.kind === "resource");
    return (
        <ImageGallery>
            <UserMessageShell>
                <MessageBubble copyText={text} data-testid={dataTestId.userMessage} speaker="user">
                    <div className="grid min-w-0 gap-2">
                        {images.length > 0 && (
                            <div className={cn("grid min-w-0 gap-1.5", images.length > 1 && "grid-cols-2")}>
                                {images.map((image, index) => (
                                    <PromptImage attachment={image} key={`${index.toString()}:${image.name}`} />
                                ))}
                            </div>
                        )}
                        {resources.length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                                {resources.map((resource) => (
                                    <span
                                        className="rounded-md border border-black/[0.06] bg-muted/40 px-2 py-1 font-mono text-[10px]"
                                        key={`${resource.uri}:${resource.name}`}
                                    >
                                        {resource.name}
                                    </span>
                                ))}
                            </div>
                        )}
                        {text.length > 0 && <AgentMarkdown markdown={text} streaming={false} />}
                    </div>
                </MessageBubble>
            </UserMessageShell>
        </ImageGallery>
    );
}
