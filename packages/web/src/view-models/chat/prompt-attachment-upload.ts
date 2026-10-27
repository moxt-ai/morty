import type { MobiusClient, PromptAttachment } from "@moxt-ai/mobius-sdk";
import type { ComposerAttachment } from "../../components/chat/composer-attachment.ts";

async function contentKey(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function uploadPromptAttachment(
    sessions: MobiusClient["sessions"],
    sessionId: string,
    attachment: ComposerAttachment,
    signal: AbortSignal,
): Promise<PromptAttachment> {
    signal.throwIfAborted();
    const key = await contentKey(attachment.bytes);
    signal.throwIfAborted();
    return await sessions.uploadContent(
        sessionId,
        {
            bytes: attachment.bytes,
            contentKey: key,
            kind: attachment.kind,
            mediaType: attachment.mediaType,
            name: attachment.name,
            uri: attachment.uri,
        },
        signal,
    );
}

export async function uploadPromptAttachments(
    sessions: MobiusClient["sessions"],
    sessionId: string,
    attachments: readonly ComposerAttachment[],
    signal: AbortSignal,
): Promise<readonly PromptAttachment[]> {
    return await Promise.all(
        attachments.map((attachment) => uploadPromptAttachment(sessions, sessionId, attachment, signal)),
    );
}
