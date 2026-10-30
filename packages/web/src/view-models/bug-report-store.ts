import { getClient, lastEventId } from "@sentry/react";
import { createStore } from "zustand/vanilla";
import {
    browserDiagnosticsSnapshot,
    type DaemonDiagnosticsSource,
} from "../services/diagnostics/browser-diagnostics.ts";
import { type BugReport, BugReportError, type BugReportSink } from "../services/diagnostics/bug-report.ts";
import type { ChatDiagnostics } from "../services/diagnostics/model-catalog.ts";
import type { BrowserNetworkOperations } from "../services/diagnostics/network-diagnostics.ts";
import { collectNetworkDiagnostics } from "./bug-report-network.ts";

export type BugReportStoreApi = ReturnType<typeof createBugReportStore>;

type ReportState =
    | { readonly kind: "editing" }
    | { readonly kind: "sending" }
    | { readonly kind: "sent"; readonly id: string; readonly daemonAvailable: boolean; readonly truncated: boolean }
    | { readonly kind: "failed"; readonly message: string };

export const bugReportImageAccept = "image/png,image/jpeg,image/gif,image/webp";
export interface BugReportImage {
    readonly id: string;
    readonly file: File;
}

export function createBugReportStore(
    sink: BugReportSink,
    browserNetwork: BrowserNetworkOperations | null,
    daemonSource: DaemonDiagnosticsSource | null,
) {
    let active: AbortController | null = null;
    const chat: ChatDiagnostics = daemonSource?.context?.() ?? { kind: "unavailable", code: "NO_CHAT_CONTEXT" };
    return createStore<{
        readonly technicalDetails: string;
        readonly state: ReportState;
        readonly description: string;
        readonly images: readonly BugReportImage[];
        readonly addImages: (files: readonly File[]) => void;
        readonly removeImage: (id: string) => void;
        readonly describe: (value: string) => void;
        readonly send: (signal?: AbortSignal) => Promise<void>;
        readonly close: () => void;
    }>((set, get) => ({
        technicalDetails: JSON.stringify(chat, null, 2),
        description: "",
        images: [],
        state: { kind: "editing" },
        addImages: (files) => {
            if (get().state.kind === "sending" || get().state.kind === "sent" || files.length === 0) {
                return;
            }
            const message =
                get().images.length + files.length > 3
                    ? "You can attach up to 3 images."
                    : files.some((file) => !bugReportImageAccept.split(",").includes(file.type))
                      ? "Only PNG, JPEG, GIF, and WebP images are supported."
                      : files.some((file) => file.size === 0 || file.size > 2_500_000)
                        ? "Images must be between 1 byte and 2.5 MB."
                        : null;
            if (message !== null) {
                set({ state: { kind: "failed", message } });
                return;
            }
            set({
                images: [...get().images, ...files.map((file) => ({ id: crypto.randomUUID(), file }))],
                state: { kind: "editing" },
            });
        },
        removeImage: (id) => {
            if (get().state.kind !== "sending" && get().state.kind !== "sent") {
                set({ images: get().images.filter((image) => image.id !== id), state: { kind: "editing" } });
            }
        },
        describe: (value) => {
            if (get().state.kind !== "sending" && get().state.kind !== "sent") {
                set({ description: value.slice(0, 2000), state: { kind: "editing" } });
            }
        },
        close: () => {
            active?.abort(new DOMException("Report closed", "AbortError"));
            active = null;
            // An aborted send must not leave the dialog in its sending state:
            // the owner keeps the dialog open, so return it to editing.
            if (get().state.kind === "sending") {
                set({ state: { kind: "editing" } });
            }
        },
        send: async (parent) => {
            if (
                parent?.aborted ||
                get().description.trim() === "" ||
                get().state.kind === "sending" ||
                get().state.kind === "sent"
            ) {
                return;
            }
            const controller = new AbortController();
            const signal = parent === undefined ? controller.signal : AbortSignal.any([parent, controller.signal]);
            active = controller;
            set({ state: { kind: "sending" } });
            try {
                const report = await collectBugReport(get().description, browserNetwork, daemonSource, chat, signal);
                const id = await sink.submit(
                    report,
                    signal,
                    get().images.map((image) => image.file),
                );
                signal.throwIfAborted();
                set({
                    state: {
                        kind: "sent",
                        id,
                        daemonAvailable: report.daemon.kind === "available",
                        truncated:
                            report.web.discarded > 0 ||
                            (report.daemon.kind === "available" && report.daemon.diagnostics.truncated),
                    },
                });
            } catch (cause) {
                if (signal.aborted) {
                    return;
                }
                set({
                    state: {
                        kind: "failed",
                        message:
                            cause instanceof BugReportError
                                ? cause.message
                                : cause instanceof Error && cause.name !== "TimeoutError"
                                  ? "The report could not be sent. Please try again."
                                  : "Sending timed out. Please try again.",
                    },
                });
            } finally {
                if (active === controller) {
                    active = null;
                }
            }
        },
    }));
}

async function collectBugReport(
    description: string,
    browserNetwork: BrowserNetworkOperations | null,
    source: DaemonDiagnosticsSource | null,
    chat: ChatDiagnostics,
    signal: AbortSignal,
): Promise<BugReport> {
    signal.throwIfAborted();
    async function collectDaemon(): Promise<BugReport["daemon"]> {
        if (source === null) {
            return { kind: "unavailable", code: "NO_ACTIVE_RUNTIME" };
        }
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
        try {
            return { kind: "available", diagnostics: await source.read(deadline) };
        } catch (cause) {
            signal.throwIfAborted();
            const code: unknown = cause instanceof Error ? Reflect.get(cause, "code") : undefined;
            return {
                kind: "unavailable",
                code: deadline.aborted
                    ? "DIAGNOSTIC_TIMEOUT"
                    : typeof code === "string" && /^[A-Z_a-z0-9]{1,64}$/u.test(code)
                      ? code
                      : "DIAGNOSTIC_UNAVAILABLE",
            };
        }
    }
    const [daemon, network] = await Promise.all([
        collectDaemon(),
        collectNetworkDiagnostics(browserNetwork, source, signal),
    ]);
    signal.throwIfAborted();
    return {
        schemaVersion: 2,
        chat,
        id: crypto.randomUUID().replaceAll("-", ""),
        createdAt: new Date().toISOString(),
        description: description.trim().slice(0, 2000),
        page: window.location.pathname.slice(0, 512),
        relatedEventId: lastEventId() ?? null,
        browser: navigator.userAgent.slice(0, 512),
        release: (getClient()?.getOptions().release ?? "development").slice(0, 128),
        botId: source?.botId ?? null,
        sessionId: source?.sessionId ?? null,
        nativeSessionId: source?.nativeSessionId ?? null,
        web: browserDiagnosticsSnapshot(),
        network,
        daemon,
    };
}
