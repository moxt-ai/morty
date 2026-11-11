import { expect, test } from "vitest";
import { CodexAcpAgent } from "../../src/engine/acp/harness/codex/agent.ts";
import type { CodexSessionUpdate } from "../../src/engine/acp/harness/codex/session-update.ts";
import { ControlledCodexFixture } from "../support/agents/controlled-codex.ts";

test("Given an embedded image prompt, When Codex emits its user item, Then the image chunk does not duplicate its bytes in the URI", async () => {
    await using fixture = await ControlledCodexFixture.create();
    const updates: CodexSessionUpdate[] = [];
    const reject = async (): Promise<never> => {
        throw new Error("Unexpected interaction");
    };
    const endpoint = new CodexAcpAgent({
        command: fixture.environment["MORTY_CODEX_PATH"] ?? "",
        cwd: process.cwd(),
        environment: fixture.environment,
        interactions: { onPermission: reject, onElicitation: reject },
        onSessionUpdate: async ({ update }) => {
            updates.push(update);
        },
    });
    const signal = AbortSignal.timeout(30_000);
    try {
        await endpoint.initialize(signal);
        const session = await endpoint.newSession({ cwd: process.cwd() }, signal);
        const data = Buffer.alloc(800_000, 1).toString("base64");
        const resource = {
            type: "resource",
            resource: { uri: "morty://bot/instructions", mimeType: "text/plain", text: "Private bot instructions" },
        } satisfies import("@agentclientprotocol/sdk/unstable").ContentBlock;
        await endpoint.prompt({
            sessionId: session.sessionId,
            prompt: [{ type: "image", data, mimeType: "image/png" }, resource],
        });
        const image = updates.find(
            (update) => update.sessionUpdate === "user_message_chunk" && update.content.type === "image",
        );
        expect(image).toMatchObject({ content: { type: "image", data, mimeType: "image/png" } });
        if (image?.sessionUpdate !== "user_message_chunk") {
            throw new Error("Missing user image chunk");
        }
        expect(image.content).not.toHaveProperty("uri");
        expect(updates).toContainEqual(
            expect.objectContaining({
                sessionUpdate: "user_message_chunk",
                messageId: image.messageId,
                content: resource,
            }),
        );
    } finally {
        await endpoint.dispose("force");
    }
});
