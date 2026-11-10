import type { ComposerAttachment } from "../../components/chat/composer-attachment.ts";
import { prependToDraft } from "./session-delivery-store.ts";

/** A returned message precedes everything written since it was sent. Only local files can be restored. */
export function returnToComposer(
    draft: string,
    attachments: readonly ComposerAttachment[],
    content: string,
    restored: readonly ComposerAttachment[],
) {
    return {
        draft: prependToDraft(content, draft),
        attachments: [...restored, ...attachments],
    };
}
