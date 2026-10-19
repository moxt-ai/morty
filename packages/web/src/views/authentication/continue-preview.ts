import type { ContinueState } from "../../view-models/authentication/continue-store.ts";

// TEMP style-tuning preview: remove this module with continue preview routes and query-param branches.
export const CONTINUE_PREVIEW_STATES = [
    "session-opening",
    "session-failed",
    "identity-redeeming",
    "failed",
    "invalid",
] as const;

export type ContinuePreviewStateId = (typeof CONTINUE_PREVIEW_STATES)[number];

const PREVIEW_CODE = "preview-transfer-code";

const previewHandoff = () =>
    ({
        harness: "claude-code",
        sessionId: "preview-native-session-0123456789",
    }) as const;

export function isContinuePreviewStateId(value: string): value is ContinuePreviewStateId {
    return (CONTINUE_PREVIEW_STATES as readonly string[]).includes(value);
}

export function getContinuePreviewStateId(searchParams: URLSearchParams): ContinuePreviewStateId | null {
    const value = searchParams.get("continuePreview");
    if (value === null) {
        return null;
    }
    return isContinuePreviewStateId(value) ? value : null;
}

export function continuePreviewState(id: ContinuePreviewStateId): ContinueState {
    switch (id) {
        case "session-opening":
            return {
                code: PREVIEW_CODE,
                handoff: previewHandoff(),
                kind: "session-opening",
            };
        case "session-failed":
            return {
                code: PREVIEW_CODE,
                handoff: previewHandoff(),
                kind: "session-failed",
                message: "This native session could not be imported. The Runtime may be offline.",
            };
        case "identity-redeeming":
            return { code: PREVIEW_CODE, kind: "identity-redeeming" };
        case "failed":
            return { kind: "failed", message: "This transfer link is unavailable." };
        case "invalid":
            return { kind: "invalid" };
    }
}

export const CONTINUE_PREVIEW_STATE_LABELS: Record<ContinuePreviewStateId, string> = {
    "session-opening": "Session opening",
    "session-failed": "Session failed",
    "identity-redeeming": "Identity redeeming (opening Morty)",
    failed: "Transfer failed",
    invalid: "Link unavailable / invalid",
};
