import { expect, test } from "vitest";
import { BotChatApi } from "../../src/services/chat/bot-chat-api.ts";
import { ChatCloudApi } from "../../src/services/chat/chat-cloud-api.ts";
import { ManagementApi } from "../../src/services/management/management-api.ts";

test("Given a signed-in web user, When they manage bots and open chat, Then management stays on Cloud and chat receives direct revocable Mobius access", async () => {
    const requests: Request[] = [];
    const fetchRequest = async (request: Request): Promise<Response> => {
        requests.push(request);
        const path = new URL(request.url).pathname;
        if (path === "/mobius-cloud/api/management/bots" && request.method === "GET") {
            return Response.json({ bots: [{ botId: "bot-one", displayName: "Research" }] });
        }
        if (path === "/mobius-cloud/api/management/bots/claims") {
            return Response.json({ botId: "bot-two", displayName: "Support" }, { status: 201 });
        }
        if (path === "/mobius-cloud/api/chat/bots/bot-one/access-tokens") {
            return Response.json(
                {
                    accessTokenId: "key-one",
                    accessToken: "v".repeat(32),
                },
                { status: 201 },
            );
        }
        if (path === "/mobius-cloud/api/management/access-tokens/key-one/regenerate") {
            return Response.json({
                accessToken: "r".repeat(32),
                accessTokenId: "key-one",
            });
        }
        if (path === "/mobius-cloud/api/chat/sessions" && request.method === "POST") {
            return Response.json({ botId: "bot-one", sessionId: "session-one", title: "Planning" }, { status: 201 });
        }
        return new Response(null, { status: 204 });
    };
    const options = { origin: "https://cloud.test", getToken: async () => "clerk-token", fetchRequest };
    const management = new ManagementApi(options);
    const chat = new ChatCloudApi({
        ...options,
        appId: "cloud-app",
        mobiusBaseUrl: "https://mobius.external",
    });
    const signal = new AbortController().signal;

    expect(await management.listBots(signal)).toEqual([{ botId: "bot-one", displayName: "Research" }]);
    expect(
        await management.claimBot(
            { botId: "bot-two", displayName: "Support", ownerCredential: "o".repeat(32) },
            signal,
        ),
    ).toEqual({ botId: "bot-two", displayName: "Support" });
    const access = await chat.open("bot-one", signal);
    expect(access).toMatchObject({
        appId: "cloud-app",
        botId: "bot-one",
        mobiusBaseUrl: "https://mobius.external",
        accessTokenId: "key-one",
    });
    const regenerated = await chat.regenerate(access, signal);
    expect(regenerated.accessToken).toBe("r".repeat(32));
    await chat.recordSession({ botId: "bot-one", sessionId: "session-one", title: "Planning" }, signal);
    await chat.renameSession("session-one", "Project planning", signal);
    await chat.deleteSession("session-one", signal);
    await chat.revoke(access, signal);

    expect(requests.every((request) => new URL(request.url).origin === "https://cloud.test")).toBe(true);
    expect(requests.every((request) => request.headers.get("authorization") === "Bearer clerk-token")).toBe(true);
    expect(requests.map((request) => new URL(request.url).pathname)).not.toContain("/mobius/api/v1/access-tokens");
});

test("Given an authenticated Bot owner, When Chat opens their Bot, Then the browser receives validated Conversation access from Cloud", async () => {
    const requests: Request[] = [];
    const credential = `mconv_${"a".repeat(22)}_${"b".repeat(43)}`;
    const api = new BotChatApi({
        origin: "https://cloud.test",
        getToken: async () => "anonymous-token",
        fetchRequest: async (request) => {
            requests.push(request);
            return Response.json({
                endpoint: "https://mobius.test",
                conversationId: "conversation-one",
                credential,
                expiresAt: "2026-09-11T12:15:00.000Z",
            });
        },
    });

    await expect(api.access("bot-one", new AbortController().signal)).resolves.toEqual({
        endpoint: "https://mobius.test",
        conversationId: "conversation-one",
        credential,
        expiresAt: "2026-09-11T12:15:00.000Z",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer anonymous-token");
    expect(new URL(requests[0]?.url ?? "https://invalid.test").pathname).toBe(
        "/mobius-cloud/api/chat/bots/bot-one/access",
    );
});
