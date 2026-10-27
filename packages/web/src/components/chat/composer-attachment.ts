export interface ComposerAttachment {
    readonly bytes: Uint8Array;
    readonly kind: "image" | "resource";
    readonly mediaType: string;
    readonly name: string;
    readonly uri: string;
}
