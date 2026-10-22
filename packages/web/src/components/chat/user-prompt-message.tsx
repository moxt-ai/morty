import type { PromptImage, PromptResource } from "@moxt-ai/mobius-sdk";
import { cn } from "@/lib/utils";
import { MessageBubble } from "../../components/chat/message-bubble.tsx";
import { UserMessageShell } from "../../components/chat/user-message-shell.tsx";
import { dataTestId } from "../../data-testid.ts";
import { AgentMarkdown } from "../agents/agent-markdown.tsx";

const SAFE_IMAGE_MIME = /^image\/(?:gif|jpeg|png|webp)$/;

interface UserPromptMessageProps {
    readonly images: readonly PromptImage[];
    readonly resources: readonly PromptResource[];
    readonly text: string;
}

export function UserPromptMessage({ images, resources, text }: UserPromptMessageProps) {
    if (text.length === 0 && images.length === 0 && resources.length === 0) {
        return null;
    }
    return (
        <UserMessageShell>
            <MessageBubble copyText={text} data-testid={dataTestId.userMessage} speaker="user">
                <div className="grid min-w-0 gap-2">
                    {images.length > 0 && (
                        <div className={cn("grid min-w-0 gap-1.5", images.length > 1 && "grid-cols-2")}>
                            {images.map((image, index) =>
                                SAFE_IMAGE_MIME.test(image.mimeType) ? (
                                    <img
                                        alt={image.name}
                                        className="h-auto max-h-56 max-w-full rounded-lg object-contain object-left"
                                        key={`${index.toString()}:${image.name}`}
                                        loading="lazy"
                                        src={`data:${image.mimeType};base64,${image.data}`}
                                    />
                                ) : (
                                    <span
                                        className="rounded-lg border border-black/[0.06] bg-muted/40 p-2 text-[10px] text-muted-foreground"
                                        key={`${index.toString()}:${image.name}`}
                                    >
                                        {image.name}
                                    </span>
                                ),
                            )}
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
                    {text.length > 0 && <AgentMarkdown className="[&_p]:my-0" markdown={text} streaming={false} />}
                </div>
            </MessageBubble>
        </UserMessageShell>
    );
}
