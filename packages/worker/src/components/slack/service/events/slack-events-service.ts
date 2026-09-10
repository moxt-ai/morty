import * as v from "valibot";
import type { SlackAppDirectory } from "../../storage/slack-app-directory";
import type { ClockService } from "../identity/clock-service";
import { slackEventsPayloadSchema } from "./events";
import { verifySlackSignature } from "./signature";
import type { SlackEventIntakeService } from "./slack-event-intake-service";

export interface ReceiveSlackEventInput {
    readonly body: string;
    readonly signature: string | null;
    readonly timestamp: string | null;
}

export type ReceiveSlackEventResult =
    | { readonly kind: "accepted" }
    | { readonly challenge: string; readonly kind: "challenge" }
    | {
          readonly code:
              | "INVALID_SIGNATURE"
              | "INVALID_SLACK_PAYLOAD"
              | "INVALID_TIMESTAMP"
              | "SLACK_SIGNATURE_REQUIRED"
              | "UNKNOWN_SLACK_APP";
          readonly kind: "rejected";
          readonly message: string;
          readonly status: 400 | 401;
      };

export class SlackEventsService {
    readonly #clock: ClockService;
    readonly #apps: SlackAppDirectory;
    readonly #intake: SlackEventIntakeService;
    constructor(cx: {
        readonly gateways: { readonly clock: ClockService; readonly slackAppDirectory: SlackAppDirectory };
        readonly services: { readonly intake: SlackEventIntakeService };
    }) {
        const { clock, slackAppDirectory: apps } = cx.gateways;
        const { intake } = cx.services;
        this.#clock = clock;
        this.#apps = apps;
        this.#intake = intake;
    }

    readonly receive = async (input: ReceiveSlackEventInput, signal: AbortSignal): Promise<ReceiveSlackEventResult> => {
        const parsed = v.safeParse(slackEventsPayloadSchema, decodeJson(input.body));
        if (!parsed.success) {
            return {
                code: "INVALID_SLACK_PAYLOAD",
                kind: "rejected",
                message: "Invalid Slack payload",
                status: 400,
            };
        }

        if (input.signature === null || input.timestamp === null) {
            return {
                code: "SLACK_SIGNATURE_REQUIRED",
                kind: "rejected",
                message: "Slack signature required",
                status: 401,
            };
        }

        const app = await this.#apps.find(parsed.output.api_app_id, signal);
        if (app === null) {
            return {
                code: "UNKNOWN_SLACK_APP",
                kind: "rejected",
                message: "Unknown Slack app",
                status: 401,
            };
        }

        const verification = await verifySlackSignature(
            {
                body: input.body,
                nowEpochSeconds: this.#clock.nowEpochSeconds(),
                signature: input.signature,
                signingSecret: app.signingSecret,
                timestamp: input.timestamp,
            },
            signal,
        );
        if (!verification.valid) {
            return {
                code: verification.code,
                kind: "rejected",
                message: "Invalid Slack signature",
                status: 401,
            };
        }

        if (parsed.output.type === "url_verification") {
            return { challenge: parsed.output.challenge, kind: "challenge" };
        }

        await this.#intake.receive(app.tenant, parsed.output, signal);
        return { kind: "accepted" };
    };
}

function decodeJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return undefined;
    }
}
