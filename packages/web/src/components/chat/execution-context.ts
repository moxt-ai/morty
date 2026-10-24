/**
 * Pure display summary of where a session runs. The view-model derives it;
 * the header, details, and composer render the same connection presentation.
 */
export interface ExecutionContext {
    readonly agentRef: string;
    readonly machine: string;
    readonly agent: string;
    readonly directory: string | null;
    readonly directoryName: string;
    readonly directoryPlaceholder: string;
    readonly computerStatus: "Online" | "Offline" | "Checking availability" | "Status unavailable" | "Not paired";
    readonly lastConfirmed: string | null;
    readonly available: boolean;
    readonly feedback: ConnectionFeedback;
    readonly indicator: {
        readonly kind: "ready" | "recovering" | "offline" | "unknown" | "failed" | "closed";
        readonly label: string;
    };
    readonly connection:
        | "Not started"
        | "Connecting"
        | "Connected"
        | "Disconnected"
        | "Reconnecting"
        | "Unavailable"
        | "Closed";
}

export type ConnectionFeedback =
    | { readonly kind: "hidden" }
    | { readonly kind: "waiting"; readonly title: string; readonly description: string }
    | {
          readonly kind: "retrying";
          readonly title: string;
          readonly description: string;
          readonly remainingSeconds: number | null;
      }
    | {
          readonly kind: "failed";
          readonly title: string;
          readonly description: string;
          readonly action: "retry" | "reload";
      }
    | {
          readonly kind: "closed";
          readonly description: string;
          readonly reopen: "available" | "reopening" | "offline" | "failed";
      };
