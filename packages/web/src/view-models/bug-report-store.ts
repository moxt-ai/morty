import { createStore } from "zustand/vanilla";
import { BugReportError, type BugReportSink, collectBugReport } from "../services/diagnostics/bug-report.ts";

type ReportState =
    | { readonly kind: "editing" }
    | { readonly kind: "sending" }
    | { readonly kind: "sent"; readonly id: string; readonly daemonAvailable: boolean; readonly truncated: boolean }
    | { readonly kind: "failed"; readonly message: string };
export function createBugReportStore(sink: BugReportSink) {
    let active: AbortController | null = null;
    return createStore<{
        readonly state: ReportState;
        readonly description: string;
        readonly describe: (value: string) => void;
        readonly send: () => Promise<void>;
        readonly close: () => void;
    }>((set, get) => ({
        description: "",
        state: { kind: "editing" },
        describe: (value) => {
            if (get().state.kind !== "sending" && get().state.kind !== "sent") {
                set({ description: value.slice(0, 2000), state: { kind: "editing" } });
            }
        },
        close: () => {
            active?.abort(new DOMException("Report closed", "AbortError"));
            active = null;
        },
        send: async () => {
            if (get().description.trim() === "" || get().state.kind === "sending" || get().state.kind === "sent") {
                return;
            }
            const controller = new AbortController();
            active = controller;
            set({ state: { kind: "sending" } });
            try {
                const report = await collectBugReport(get().description, controller.signal);
                const id = await sink.submit(report, controller.signal);
                controller.signal.throwIfAborted();
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
                if (controller.signal.aborted) {
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
