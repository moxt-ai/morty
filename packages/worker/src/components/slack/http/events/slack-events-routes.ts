import { Hono } from "hono";
import { RequestError } from "../../../../infra/request-error.ts";
import type { SlackHttpEnvironment } from "../slack-http-environment";

export function createSlackEventsRoutes() {
    return new Hono<SlackHttpEnvironment>().post("/events", async (context) => {
        const { slackEvents } = context.env.services;
        const result = await slackEvents.receive(
            {
                body: await context.req.text(),
                signature: context.req.header("x-slack-signature") ?? null,
                timestamp: context.req.header("x-slack-request-timestamp") ?? null,
            },
            context.req.raw.signal,
        );

        switch (result.kind) {
            case "accepted":
                return context.json({ accepted: true }, 202);
            case "challenge":
                return context.json({ challenge: result.challenge });
            case "rejected":
                throw new RequestError(result.code, result.message, result.status);
        }
    });
}
