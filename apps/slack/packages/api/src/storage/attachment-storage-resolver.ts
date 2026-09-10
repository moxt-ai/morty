import type { TenantShardResolution } from "../service/identity/tenant-shard-resolver";
import type { SlackAttachmentStorage } from "./slack-attachment-storage";

export interface AttachmentStorageResolver {
    readonly resolve: (sharding: TenantShardResolution) => SlackAttachmentStorage;
}
