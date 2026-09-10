import { createServer } from "node:http";
import { expect, test } from "vitest";
import { MobiusGateway } from "../../../packages/worker/src/components/slack/gateway/mobius-gateway";
import { MobiusFetchGateway } from "../../../packages/worker/src/components/slack/infra/mobius-fetch-gateway";
import { InMemoryMobius } from "../app/in-memory-mobius-gateway";

test("Given a Mobius Bot service on another origin, When Slack redeems a grant and sends a message, Then the authorized bot conversation returns its reply", async () => {
    const peer = new InMemoryMobius();
    const grant = peer.ownBot("mobius-bot");
    const server = createServer(async (request, response) => {
        try {
            let body = "";
            for await (const chunk of request) {
                body += chunk.toString();
            }
            const result = await peer.fetch(request.url ?? "/", {
                method: request.method ?? "GET",
                headers: { Authorization: request.headers.authorization ?? "" },
                ...(body ? { body } : {}),
            });
            response.writeHead(result.status, { "Content-Type": "application/json" });
            response.end(await result.text());
        } catch {
            response.writeHead(500);
            response.end();
        }
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    try {
        const address = server.address();
        if (address === null || typeof address === "string") {
            throw new Error("Expected TCP server");
        }
        const config = { mobiusBaseUrl: `http://127.0.0.1:${address.port}` };
        const gateway = new MobiusGateway({ gateways: { mobiusFetchGateway: new MobiusFetchGateway({ config }) } });
        const signal = new AbortController().signal;
        expect(await gateway.listProjects(null, signal)).toEqual({
            projects: [{ projectId: "standalone-project", displayName: "Standalone" }],
        });
        expect(await gateway.listProjectBots("standalone-project", null, signal)).toEqual({
            bots: [{ botId: "mobius-bot", displayName: "mobius-bot", lifecycle: "draft" }],
        });
        const binding = await gateway.connectBot("tenant", "slack-bot", grant, signal);
        const conversation = await gateway.createConversation(binding, "slack-conversation", signal);
        expect(
            await gateway.prompt(
                {
                    binding,
                    conversationId: conversation,
                    clientMessageId: "message",
                    prompt: "Help",
                    actorRef: "slack:user",
                },
                signal,
            ),
        ).toEqual({ text: "Investigation complete", stopReason: "end_turn" });
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
        });
    }
});
