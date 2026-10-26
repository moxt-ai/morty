import { decodeIdentifier } from "@moxt-ai/mobius-sdk/protocol";
import type { ContinueState } from "../../view-models/authentication/continue-store.ts";

// TEMP style-tuning preview: remove this module with continue preview routes and query-param branches.
export const CONTINUE_PREVIEW_STATES = [
    "session-opening",
    "session-resuming",
    "session-failed",
    "redeem-failed",
    "identity-redeeming",
    "link-unavailable-setup",
    "link-unavailable",
    "failed",
    "invalid",
] as const;

export type ContinuePreviewStateId = (typeof CONTINUE_PREVIEW_STATES)[number];

const PREVIEW_CODE = "preview-transfer-code";

type PreviewHandoff = Extract<ContinueState, { readonly kind: "session-opening" }>["handoff"];
type PreviewIdentity = Extract<ContinueState, { readonly kind: "session-resuming" }>["identity"];

const previewHandoff = (): PreviewHandoff => ({
    harness: "claude-code",
    sessionId: "preview-native-session-0123456789",
});

const previewIdentity = (): PreviewIdentity => ({
    botId: decodeIdentifier("preview-bot"),
    projectId: "prj_wn_01_previewpreviewpreview1",
    token: "preview-token",
    userId: "preview-user",
});

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
        case "session-resuming":
            return {
                handoff: previewHandoff(),
                identity: previewIdentity(),
                kind: "session-resuming",
            };
        case "session-failed":
            return {
                handoff: previewHandoff(),
                identity: previewIdentity(),
                kind: "session-failed",
                message: "This native session could not be imported. The Runtime may be offline.",
            };
        case "redeem-failed":
            return {
                code: PREVIEW_CODE,
                handoff: previewHandoff(),
                kind: "redeem-failed",
                message: "Check your connection and try again.",
            };
        case "identity-redeeming":
            return { code: PREVIEW_CODE, kind: "identity-redeeming" };
        case "link-unavailable-setup":
            return {
                kind: "link-unavailable",
                recovery: "setup",
                message: "This transfer link has expired or been revoked.",
            };
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
    "session-resuming": "Session resuming",
    "session-failed": "Session failed",
    "redeem-failed": "Session link redeem failed",
    "identity-redeeming": "Identity redeeming (opening Morty)",
    "link-unavailable-setup": "Expired session handoff link",
    "link-unavailable": "Expired sharing link",
    failed: "Transfer failed",
    invalid: "Link unavailable / invalid",
};
