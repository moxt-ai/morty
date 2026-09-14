import type { ManagementHttpEnvironment } from "./management-http-environment.ts";
import { projectLocationHint } from "./project-location.ts";

export async function provisionUserBot(
    env: ManagementHttpEnvironment["Bindings"],
    userId: string,
    signal: AbortSignal,
    request: Request,
) {
    const existing = (await env.storages.managedBots.listBots(userId, signal))[0];
    if (existing !== undefined) {
        return existing;
    }
    const gateway = env.gateways.platformProjects;
    const { origin, appId } = gateway.configuration();
    const project =
        (await env.storages.platformProjects.read(userId, origin, appId, signal)) ??
        (await gateway.create(userId, "Personal workspace", signal, projectLocationHint(request)));
    await env.storages.platformProjects.save(userId, origin, appId, project, signal);
    const bot = await gateway.createBot(project.projectId, signal);
    await env.storages.managedBots.saveClaim(userId, bot, Date.now(), signal);
    env.logger.info({ event: "user-bot-created", userId, botId: bot.botId }, "Bot audit event");
    return bot;
}
