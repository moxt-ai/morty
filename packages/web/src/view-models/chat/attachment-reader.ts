import { PROMPT_IMAGE_MAX_BYTES } from "@moxt-ai/mobius-sdk/protocol";
import type { ComposerAttachment } from "../../components/chat/composer-attachment.ts";

const RESOURCE_BYTES_LIMIT = 1_000_000;
const READ_TIMEOUT_MILLISECONDS = 15_000;

export class AttachmentReadError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "AttachmentReadError";
    }
}

function readBytes(file: File, signal: AbortSignal): Promise<ArrayBuffer> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        const timeout = window.setTimeout(() => {
            reader.abort();
            reject(new AttachmentReadError("attachment_timeout", `Timed out while reading ${file.name}.`));
        }, READ_TIMEOUT_MILLISECONDS);
        const cleanup = (): void => {
            signal.removeEventListener("abort", cancel);
            window.clearTimeout(timeout);
            reader.removeEventListener("abort", handleAbort);
            reader.removeEventListener("error", handleError);
            reader.removeEventListener("load", handleLoad);
        };
        const handleAbort = (): void => {
            cleanup();
            reject(
                signal.aborted
                    ? signal.reason
                    : new AttachmentReadError("attachment_cancelled", `Reading ${file.name} was cancelled.`),
            );
        };
        const handleError = (): void => {
            cleanup();
            reject(
                new AttachmentReadError("attachment_read_failed", `Could not read ${file.name}.`, {
                    cause: reader.error,
                }),
            );
        };
        const handleLoad = (): void => {
            const result = reader.result;
            cleanup();
            if (!(result instanceof ArrayBuffer)) {
                reject(
                    new AttachmentReadError("attachment_read_failed", `${file.name} did not contain readable bytes.`),
                );
                return;
            }
            resolve(result);
        };
        const cancel = (): void => reader.abort();
        signal.addEventListener("abort", cancel, { once: true });
        reader.addEventListener("abort", handleAbort, { once: true });
        reader.addEventListener("error", handleError, { once: true });
        reader.addEventListener("load", handleLoad, { once: true });
        reader.readAsArrayBuffer(file);
    });
}

function attachmentUri(name: string): string {
    return `attachment:///${encodeURIComponent(name.replaceAll("/", "_"))}`;
}

export async function readPromptAttachment(file: File, signal: AbortSignal): Promise<ComposerAttachment> {
    signal.throwIfAborted();
    const image = file.type.startsWith("image/");
    const limit = image ? PROMPT_IMAGE_MAX_BYTES : RESOURCE_BYTES_LIMIT;
    if (file.size === 0 || file.size > limit) {
        throw new AttachmentReadError(
            "attachment_size_invalid",
            image ? "Images must be between 1 byte and 5 MB." : "Text resources must be between 1 byte and 1 MB.",
        );
    }
    const bytes = new Uint8Array(await readBytes(file, signal));
    signal.throwIfAborted();
    if (image) {
        if (!/^image\/(?:gif|jpeg|png|webp)$/.test(file.type)) {
            throw new AttachmentReadError(
                "attachment_type_unsupported",
                "Only PNG, JPEG, GIF, and WebP images are supported.",
            );
        }
        return {
            bytes,
            kind: "image",
            mediaType: file.type,
            name: file.name,
            uri: attachmentUri(file.name),
        };
    }
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return {
        bytes,
        kind: "resource",
        mediaType: file.type.length > 0 ? file.type : "text/plain",
        name: file.name,
        uri: attachmentUri(file.name),
    };
}
