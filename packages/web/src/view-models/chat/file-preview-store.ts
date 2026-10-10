import { createStore } from "zustand/vanilla";
import { isDisplayableImageType } from "../../services/chat/image-media-type.ts";
import { downloadLocalFile, type LocalFileDownload } from "../../services/chat/local-file-download.ts";

const TEXT_MIME = /^(?:text\/|application\/(?:json|xml|javascript|x-httpd-php|x-sh|x-yaml))(?:;|$)/u;
const TEXT_EXTENSIONS = new Set([
    "bash",
    "c",
    "cc",
    "conf",
    "cpp",
    "css",
    "csv",
    "env",
    "go",
    "graphql",
    "h",
    "hpp",
    "htm",
    "html",
    "ini",
    "java",
    "js",
    "jsx",
    "json",
    "log",
    "md",
    "mdx",
    "php",
    "properties",
    "py",
    "rb",
    "rs",
    "sh",
    "sql",
    "svg",
    "toml",
    "ts",
    "tsx",
    "txt",
    "xml",
    "yaml",
    "yml",
    "zsh",
]);
const TEXT_NAMES = new Set(["dockerfile", "gemfile", "license", "makefile", "readme"]);

export type FilePreviewState =
    | { readonly kind: "closed" }
    | { readonly kind: "loading"; readonly path: string }
    | { readonly kind: "text"; readonly name: string; readonly path: string; readonly text: string }
    | {
          readonly bytes: Uint8Array;
          readonly kind: "image";
          readonly mediaType: string;
          readonly name: string;
          readonly path: string;
      }
    | { readonly kind: "failed"; readonly message: string; readonly path: string };

interface FilePreviewStore {
    readonly state: FilePreviewState;
    readonly close: () => void;
    readonly open: (path: string, signal: AbortSignal) => Promise<void>;
}

interface LocalFileResult {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly modifiedAt: string;
    readonly name: string;
}

export interface FilePreviewPort {
    readonly download: (file: LocalFileDownload) => void;
    readonly read: (path: string, signal: AbortSignal) => Promise<LocalFileResult>;
}

function isTextFile(file: LocalFileResult): boolean {
    if (TEXT_MIME.test(file.mediaType.toLowerCase())) {
        return true;
    }
    const name = file.name.toLowerCase();
    if (TEXT_NAMES.has(name)) {
        return true;
    }
    const extension = name.includes(".") ? (name.split(".").at(-1) ?? "") : "";
    return TEXT_EXTENSIONS.has(extension);
}

function createFilePreviewStore(
    port: FilePreviewPort,
    decoder: TextDecoder = new TextDecoder("utf-8", { fatal: true }),
) {
    let active: AbortController | null = null;
    return createStore<FilePreviewStore>()((set) => ({
        state: { kind: "closed" },
        close: () => {
            active?.abort();
            active = null;
            set({ state: { kind: "closed" } });
        },
        open: async (path, signal) => {
            active?.abort();
            const controller = new AbortController();
            active = controller;
            const timeoutSignal = AbortSignal.timeout(20_000);
            const operationSignal = AbortSignal.any([signal, controller.signal, timeoutSignal]);
            set({ state: { kind: "loading", path } });
            try {
                const file = await port.read(path, operationSignal);
                operationSignal.throwIfAborted();
                if (active !== controller) {
                    return;
                }
                if (isDisplayableImageType(file.mediaType)) {
                    set({
                        state: {
                            bytes: file.bytes,
                            kind: "image",
                            mediaType: file.mediaType,
                            name: file.name,
                            path,
                        },
                    });
                    return;
                }
                if (isTextFile(file)) {
                    try {
                        set({ state: { kind: "text", name: file.name, path, text: decoder.decode(file.bytes) } });
                        return;
                    } catch {}
                }
                port.download(file);
                set({ state: { kind: "closed" } });
            } catch {
                if (controller.signal.aborted) {
                    return;
                }
                signal.throwIfAborted();
                if (active === controller) {
                    set({
                        state: {
                            kind: "failed",
                            message: timeoutSignal.aborted
                                ? "The local file preview timed out."
                                : "The local file could not be opened.",
                            path,
                        },
                    });
                }
            } finally {
                if (active === controller) {
                    active = null;
                }
            }
        },
    }));
}

export function createBrowserFilePreviewStore(read: FilePreviewPort["read"]) {
    return createFilePreviewStore({ download: downloadLocalFile, read });
}
