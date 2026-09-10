import type { SlackFileService } from "../../service/bot-tools/slack-file-service";
import type { TenantShardingDirectory } from "../../service/identity/tenant-context";
import { TenantStorageError } from "../../storage/tenant-storage-error";

export function createSlackFileHandler(files: SlackFileService, tenants: TenantShardingDirectory) {
    return async (request: Request): Promise<Response> => {
        let key: string;
        try {
            key = decodeURIComponent(new URL(request.url).pathname.slice("/mobius-slack/api/files/".length));
        } catch {
            return new Response("Not found", { status: 404 });
        }
        const parts = key.split("/");
        const tenantId = parts[0] === "slack-attachments" ? parts[1] : parts[0];
        if (!tenantId || !key.includes("/") || parts.some((part) => part === "." || part === ".." || part === "")) {
            return new Response("Not found", { status: 404 });
        }
        try {
            const tenant = await tenants.resolve(tenantId, request.signal);
            return await files.download(tenant, key, request.signal);
        } catch (cause) {
            request.signal.throwIfAborted();
            if (cause instanceof TenantStorageError) {
                return cause.toResponse();
            }
            throw cause;
        }
    };
}
