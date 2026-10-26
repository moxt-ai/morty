import { decodeIdentifier } from "@moxt-ai/mobius-sdk/protocol";
import { CloudApiError } from "../../services/management/management-api.ts";
import type { ContinueState } from "../../view-models/authentication/continue-store.ts";
import { sessionFailure } from "../../view-models/chat/session-failure.ts";

// TEMP style-tuning preview: remove this module with continue preview routes and query-param branches.
export const CONTINUE_PREVIEW_STATES = [
    "session-opening",
    "session-failed",
    "identity-redeeming",
    "link-unavailable",
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
    return CONTINUE_PREVIEW_STATES.some((state) => state === value);
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
                handoff: previewHandoff(),
                identity: {
                    botId: decodeIdentifier("preview-bot"),
                    projectId: "prj_wn_01_previewpreviewpreview1",
                    token: "preview-token",
                    userId: "preview-user",
                },
                kind: "session-failed",
                error: sessionFailure(new CloudApiError("runtime_offline", "The Runtime is offline.")),
            };
        case "identity-redeeming":
            return { code: PREVIEW_CODE, kind: "identity-redeeming" };
        case "link-unavailable":
            return {
                kind: "link-unavailable",
                recovery: "share",
                message: "This transfer link has expired or been revoked.",
            };
        case "failed":
            return { kind: "failed", code: "preview", message: "This transfer link is unavailable." };
        case "invalid":
            return { kind: "invalid" };
    }
}

export const CONTINUE_PREVIEW_STATE_LABELS: Record<ContinuePreviewStateId, string> = {
    "session-opening": "Session opening",
    "session-failed": "Session failed",
    "identity-redeeming": "Identity redeeming (opening Morty)",
    "link-unavailable": "Expired sharing link",
    failed: "Transfer failed",
    invalid: "Link unavailable / invalid",
};
