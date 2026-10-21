import { MobiusError } from "@moxt-ai/mobius-sdk";
import { createStore } from "zustand/vanilla";
import {
    createHtmlPreviewDocument,
    type HtmlPreviewDocument,
    type HtmlPreviewFailure,
} from "../../services/chat/html-preview-document.ts";
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
          readonly kind: "html";
          readonly name: string;
          readonly path: string;
          readonly text: string;
          readonly view:
              | { readonly kind: "source" }
              | {
                    readonly kind: "preview";
                    readonly document: HtmlPreviewDocument;
                    readonly diagnostic:
                        | { readonly kind: "none" }
                        | { readonly kind: "failed"; readonly code: HtmlPreviewFailure; readonly message: string };
                };
      }
    | {
          readonly bytes: Uint8Array;
          readonly kind: "image";
          readonly mediaType: string;
          readonly name: string;
          readonly path: string;
      }
    | {
          readonly kind: "failed";
          readonly code: "timeout" | "offline" | "unavailable";
          readonly message: string;
          readonly path: string;
      };

interface FilePreviewStore {
    readonly state: FilePreviewState;
    readonly close: () => void;
    readonly open: (path: string, signal: AbortSignal) => Promise<void>;
    readonly reload: (signal: AbortSignal) => Promise<void>;
    readonly showHtml: (view: "preview" | "source") => void;
    readonly reportHtmlFailure: (id: string, code: HtmlPreviewFailure) => void;
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

function isHtmlFile(file: LocalFileResult): boolean {
    return /^text\/html(?:;|$)/iu.test(file.mediaType) || /\.html?$/iu.test(file.name);
}

const HTML_FAILURE_MESSAGES: Readonly<Record<HtmlPreviewFailure, string>> = {
    policy: "This page uses a resource or capability that previews do not allow. You can inspect its source or reload.",
    resource: "A page resource could not be loaded. Check your connection, reload, or inspect the source.",
    script: "The page reported a script error. You can inspect its source or reload.",
};

function readFailure(cause: unknown, timedOut: boolean, path: string): Extract<FilePreviewState, { kind: "failed" }> {
    const code = cause instanceof MobiusError ? cause.code : null;
    if (timedOut || code === "operation_timeout") {
        return { kind: "failed", code: "timeout", path, message: "The local file preview timed out. Try reloading." };
    }
    if (code === "runtime_offline" || code === "session_not_connected") {
        return {
            kind: "failed",
            code: "offline",
            path,
            message: "Your computer is offline or disconnected. Reconnect it, then reload the file.",
        };
    }
    return {
        kind: "failed",
        code: "unavailable",
        path,
        message: "The local file could not be opened. Check that it is available, then reload.",
    };
}

function createFilePreviewStore(
    port: FilePreviewPort,
    decoder: TextDecoder = new TextDecoder("utf-8", { fatal: true }),
) {
    let active: AbortController | null = null;
    return createStore<FilePreviewStore>()((set, get) => ({
        state: { kind: "closed" },
        close: () => {
            active?.abort();
            active = null;
            set({ state: { kind: "closed" } });
        },
        reload: async (signal) => {
            const { state, open } = get();
            if (state.kind !== "closed" && state.kind !== "loading") {
                await open(state.path, signal);
            }
        },
        showHtml: (view) => {
            const { state } = get();
            if (state.kind !== "html" || state.view.kind === view) {
                return;
            }
            set({
                state: {
                    ...state,
                    view:
                        view === "preview"
                            ? {
                                  kind: "preview",
                                  document: createHtmlPreviewDocument(state.text),
                                  diagnostic: { kind: "none" },
                              }
                            : { kind: "source" },
                },
            });
        },
        reportHtmlFailure: (id, code) => {
            const { state } = get();
            if (
                state.kind === "html" &&
                state.view.kind === "preview" &&
                state.view.document.id === id &&
                state.view.diagnostic.kind === "none"
            ) {
                set({
                    state: {
                        ...state,
                        view: {
                            ...state.view,
                            diagnostic: { kind: "failed", code, message: HTML_FAILURE_MESSAGES[code] },
                        },
                    },
                });
            }
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
                if (isHtmlFile(file) || isTextFile(file)) {
                    try {
                        const text = decoder.decode(file.bytes);
                        set({
                            state: isHtmlFile(file)
                                ? {
                                      kind: "html",
                                      name: file.name,
                                      path,
                                      text,
                                      view: {
                                          kind: "preview",
                                          document: createHtmlPreviewDocument(text),
                                          diagnostic: { kind: "none" },
                                      },
                                  }
                                : { kind: "text", name: file.name, path, text },
                        });
                        return;
                    } catch {}
                }
                port.download(file);
                set({ state: { kind: "closed" } });
            } catch (cause) {
                if (controller.signal.aborted) {
                    return;
                }
                signal.throwIfAborted();
                if (active === controller) {
                    set({ state: readFailure(cause, timeoutSignal.aborted, path) });
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
