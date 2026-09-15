export interface BotSlackInstallation {
    readonly botToken: string;
    readonly slackAppId: string;
    readonly tenantId: string;
}

export interface SlackAppConfiguration {
    readonly botId: string;
    readonly clientId: string;
    readonly clientSecretEncrypted: string;
    readonly id: number;
    readonly oauthRedirectUri: string;
    readonly tenantId: string;
}

export interface SlackInstallationRecord {
    readonly slackAppRecordId: number;
    readonly slackTeamId: string;
    readonly tenantId: string;
}

export interface ManagedSlackApp {
    readonly botId: string;
    readonly appName: string;
    readonly clientId: string;
    readonly id: number;
    readonly slackAppId: string;
    readonly status: "disabled" | "enabled";
    readonly tenantId: string;
}

export interface ManagedSlackInstallation {
    readonly slackTeamId: string;
    readonly slackTeamName: string | null;
    readonly status: "connected" | "error" | "token_revoked" | "uninstalled";
}
