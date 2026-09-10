import type { SlackAttachmentStorage } from "./slack-attachment-storage";

export interface AttachmentStorageResolver {
    readonly resolve: () => SlackAttachmentStorage;
}
