import type { SlackWebApi } from "../../../../gateway/slack-web-gateway";
import type { AttachmentStorageResolver } from "../../storage/attachment-storage-resolver";
import type { StoredSlackEventTarget } from "../../storage/slack-event-records";
import type { SlackMessage, SlackMessageFile } from "../bot-tools/slack-bot-tool-service";
import type { TenantContext } from "../identity/tenant-context";

export class SlackMessageRenderer {
    private readonly slack: SlackWebApi;
    private readonly attachments: AttachmentStorageResolver;
    private readonly publicBaseUrl: string;
    constructor(cx: {
        readonly gateways: {
            readonly slackWebApi: SlackWebApi;
            readonly attachmentStorageResolver: AttachmentStorageResolver;
        };
        readonly config: { readonly publicBaseUrl: string };
    }) {
        const { slackWebApi: slack, attachmentStorageResolver: attachments } = cx.gateways;
        const { publicBaseUrl } = cx.config;
        this.slack = slack;
        this.attachments = attachments;
        this.publicBaseUrl = publicBaseUrl;
    }

    readonly render = async (
        tenant: TenantContext,
        target: StoredSlackEventTarget,
        message: SlackMessage,
        signal: AbortSignal,
    ): Promise<string> => {
        const author =
            message.userId === null
                ? (message.botId ?? "unknown-bot")
                : await this.slack.getUserName(target.botToken, message.userId, signal);
        const files = await this.renderFiles(tenant, target, message.files, signal);
        return `[${message.ts}] ${author}: ${[message.text, files].filter(Boolean).join(" ")}`;
    };

    readonly renderFiles = async (
        _tenant: TenantContext,
        target: StoredSlackEventTarget,
        files: readonly SlackMessageFile[],
        signal: AbortSignal,
    ): Promise<string> => {
        const rendered: string[] = [];
        for (const file of files) {
            if (file.urlPrivate === null) {
                continue;
            }
            const response = await this.slack.downloadFile(target.botToken, file.urlPrivate, signal);
            if (!response.ok) {
                continue;
            }
            const normalized = (file.name ?? file.id).replaceAll(/[^A-Za-z0-9._-]/gu, "_");
            const name = normalized.length === 0 ? "file" : normalized.slice(0, 180);
            const key = `slack-attachments/${target.tenantId}/${target.slackTeamId}/${file.id}/${name}`;
            await this.attachments.resolve().put(key, response, file.mimetype ?? "application/octet-stream", signal);
            rendered.push(
                `[file: ${file.name ?? file.id}](${this.publicBaseUrl}/mobius-slack/api/files/${encodeURIComponent(key)})`,
            );
        }
        return rendered.join(" ");
    };
}
