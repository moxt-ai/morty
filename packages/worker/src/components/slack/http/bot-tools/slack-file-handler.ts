import { json } from "../../../../infra/http.ts";
import type { SlackFileService } from "../../service/bot-tools/slack-file-service.ts";
import { tenantContext } from "../../service/identity/tenant-context.ts";
import { TenantStorageError } from "../../storage/tenant-storage-error.ts";

export function createSlackFileHandler(files: SlackFileService) {
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
            return await files.download(tenantContext(tenantId), key, request.signal);
        } catch (cause) {
            request.signal.throwIfAborted();
            if (cause instanceof TenantStorageError) {
                const response = cause.toHttpJson();
                return json(response.body, response.status, response.headers);
            }
            throw cause;
        }
    };
}
