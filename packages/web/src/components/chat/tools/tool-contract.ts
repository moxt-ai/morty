import type { AgentDisplayContent } from "../../agents/display-content.ts";

/**
 * Presentational contract for a tool call in the timeline. The projection in
 * the view-model layer produces it; the tool renderers consume it.
 */
export type SessionToolCallState =
    | { readonly kind: "running" }
    | { readonly kind: "succeeded" }
    | { readonly kind: "failed" }
    | { readonly kind: "interrupted" }
    | { readonly kind: "unknown" };

export interface SessionToolPresentation {
    readonly content: readonly AgentDisplayContent[];
    readonly id: string;
    readonly input: string;
    readonly kind: "tool";
    readonly name: string;
    readonly output: string;
    readonly state: SessionToolCallState;
    readonly title: string;
}

export const REASONING_CHARACTER_LIMIT = 16 * 1024;
