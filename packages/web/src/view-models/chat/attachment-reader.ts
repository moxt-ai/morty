import {
    isPromptBinaryDocument,
    isPromptSvg,
    isPromptTextMediaType,
    isRasterPromptImage,
    isSvgDocument,
    PROMPT_DOCUMENT_MAX_BYTES,
    PROMPT_IMAGE_MAX_BYTES,
    PROMPT_SVG_MEDIA_TYPE,
    PROMPT_TEXT_RESOURCE_MAX_BYTES,
} from "@moxt-ai/mobius-sdk/protocol";
import { type ComposerAttachment, promptAttachmentMediaType } from "../../components/chat/composer-attachment.ts";

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

function sizeLimit(mediaType: string): { readonly limit: number; readonly message: string } {
    if (isRasterPromptImage(mediaType)) {
        return { limit: PROMPT_IMAGE_MAX_BYTES, message: "Images must be between 1 byte and 5 MB." };
    }
    if (isPromptSvg(mediaType)) {
        return { limit: PROMPT_TEXT_RESOURCE_MAX_BYTES, message: "SVG images must be between 1 byte and 1 MB." };
    }
    if (isPromptBinaryDocument(mediaType)) {
        return { limit: PROMPT_DOCUMENT_MAX_BYTES, message: "Documents must be between 1 byte and 5 MB." };
    }
    return { limit: PROMPT_TEXT_RESOURCE_MAX_BYTES, message: "Text resources must be between 1 byte and 1 MB." };
}

function decodeText(file: File, bytes: Uint8Array): void {
    try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (cause) {
        throw new AttachmentReadError("attachment_encoding_invalid", `${file.name} is not valid UTF-8 text.`, {
            cause,
        });
    }
}

export async function readPromptAttachment(file: File, signal: AbortSignal): Promise<ComposerAttachment> {
    signal.throwIfAborted();
    const mediaType = promptAttachmentMediaType(file);
    const raster = isRasterPromptImage(mediaType);
    const svg = isPromptSvg(mediaType);
    const document = isPromptBinaryDocument(mediaType);
    const textual = isPromptTextMediaType(mediaType) && !svg;
    if (!raster && !svg && !document && !textual) {
        throw new AttachmentReadError("attachment_type_unsupported", "This attachment type is not supported.");
    }
    const { limit, message } = sizeLimit(mediaType);
    if (file.size === 0 || file.size > limit) {
        throw new AttachmentReadError("attachment_size_invalid", message);
    }
    const bytes = new Uint8Array(await readBytes(file, signal));
    signal.throwIfAborted();
    if (isRasterPromptImage(mediaType)) {
        return {
            bytes,
            kind: "image",
            mediaType,
            name: file.name,
            uri: attachmentUri(file.name),
        };
    }
    if (isPromptSvg(mediaType)) {
        let text = "";
        try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch (cause) {
            throw new AttachmentReadError("attachment_encoding_invalid", `${file.name} is not valid UTF-8 text.`, {
                cause,
            });
        }
        if (!isSvgDocument(text)) {
            throw new AttachmentReadError(
                "attachment_type_unsupported",
                "SVG attachments must be valid SVG documents.",
            );
        }
        return {
            bytes,
            kind: "image",
            mediaType: PROMPT_SVG_MEDIA_TYPE,
            name: file.name,
            uri: attachmentUri(file.name),
        };
    }
    if (isPromptBinaryDocument(mediaType)) {
        return {
            bytes,
            kind: "resource",
            mediaType,
            name: file.name,
            uri: attachmentUri(file.name),
        };
    }
    decodeText(file, bytes);
    return {
        bytes,
        kind: "resource",
        mediaType,
        name: file.name,
        uri: attachmentUri(file.name),
    };
}
