import type { RequestAccessMetrics } from "./request-access-metrics.ts";

export interface CloudBindings {
    readonly CHAT_PROJECTS?: unknown;
    readonly CHAT_ATTACHMENTS_APAC?: unknown;
    readonly CHAT_ATTACHMENTS_WNAM?: unknown;
    readonly ATTACHMENTS?: unknown;
    readonly BOT_TRIGGER_RATE_LIMITER?: unknown;
    readonly APP_ORIGIN?: unknown;
    readonly ASSETS?: unknown;
    readonly AUTHENTICATION_BASE_URL?: unknown;
    readonly CLERK_JWT_KEY?: unknown;
    readonly CLERK_PUBLISHABLE_KEY?: unknown;
    readonly DATABASE?: unknown;
    readonly CHAT_PROJECT_ID?: string;
    readonly EVENTS?: unknown;
    readonly MOBIUS_BASE_URL?: unknown;
    readonly MOBIUS_APP_ID?: unknown;
    readonly MOBIUS_APP_SECRET?: unknown;
    readonly SLACK_MOBIUS_AUTH_TOKEN?: unknown;
    readonly SLACK_OAUTH_STATE_SIGNING_KEY?: unknown;
    readonly SLACK_SERVER_BASE_URL?: unknown;
    readonly SLACK_TOKEN_ENCRYPTION_KEY?: unknown;
    readonly RUNTIME_RELAY?: unknown;
    readonly SESSION_ACTIVE_SESSIONS_PER_PROJECT?: unknown;
    readonly SESSION_ACTIVE_SESSIONS_PER_TENANT?: unknown;
    readonly SESSION_RELAY?: unknown;
    readonly requestAccessMetrics?: RequestAccessMetrics;
}
