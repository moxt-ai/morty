import {
    isPromptBinaryDocument,
    isPromptSvg,
    isPromptTextMediaType,
    isRasterPromptImage,
    normalizePromptMediaType,
} from "@moxt-ai/mobius-sdk/protocol";

export interface ComposerAttachment {
    readonly bytes: Uint8Array;
    readonly kind: "image" | "resource";
    readonly mediaType: string;
    readonly name: string;
    readonly uri: string;
}

/** File-picker hint. The reader still decides which of these files can be sent. */
export const promptAttachmentAccept = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/svg+xml",
    ".svg",
    "application/pdf",
    ".pdf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
    ".rtf",
    ".odt",
    ".ods",
    ".odp",
    "text/*",
    ".md",
    ".json",
    ".csv",
    ".yaml",
    ".yml",
    ".xml",
].join(",");

const EXTENSION_MEDIA_TYPES: Readonly<Record<string, string>> = {
    csv: "text/csv",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    gif: "image/gif",
    htm: "text/html",
    html: "text/html",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    md: "text/markdown",
    odp: "application/vnd.oasis.opendocument.presentation",
    ods: "application/vnd.oasis.opendocument.spreadsheet",
    odt: "application/vnd.oasis.opendocument.text",
    pdf: "application/pdf",
    png: "image/png",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    rtf: "application/rtf",
    svg: "image/svg+xml",
    txt: "text/plain",
    webp: "image/webp",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xml: "application/xml",
    yaml: "application/yaml",
    yml: "application/yaml",
};

function fileExtension(name: string): string {
    const leaf = name.split(/[/\\]/u).pop() ?? "";
    const dot = leaf.lastIndexOf(".");
    if (dot <= 0 || dot === leaf.length - 1) {
        return "";
    }
    return leaf.slice(dot + 1).toLowerCase();
}

/** The media type used to classify a composer file, preferring a known extension when the browser omits one. */
export function promptAttachmentMediaType(file: { readonly name: string; readonly type: string }): string {
    const explicit = normalizePromptMediaType(file.type);
    if (explicit.length > 0 && explicit !== "application/octet-stream") {
        return explicit;
    }
    return EXTENSION_MEDIA_TYPES[fileExtension(file.name)] ?? (explicit.length > 0 ? explicit : "text/plain");
}

export function isPromptAttachmentCandidate(file: { readonly name: string; readonly type: string }): boolean {
    const mediaType = promptAttachmentMediaType(file);
    return (
        isRasterPromptImage(mediaType) ||
        isPromptSvg(mediaType) ||
        isPromptBinaryDocument(mediaType) ||
        isPromptTextMediaType(mediaType)
    );
}
