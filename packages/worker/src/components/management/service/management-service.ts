import type { PlatformProjectGateway } from "../../../gateway/platform-project-gateway.ts";
import type { MobiusAppService } from "../../chat/service/mobius-app-service.ts";
import { ManagementError } from "../entity/management-error.ts";
import { type PlatformProject, PlatformProjectError } from "../entity/platform-project.ts";
import type { ManagedBotStorage } from "../storage/managed-bot-storage.ts";
import type { PlatformProjectStorage } from "../storage/platform-project-storage.ts";
import type { AuthenticationService } from "./authentication-service.ts";

type LocationHint = "apac" | "wnam" | undefined;

interface AuditLogger {
    readonly info: (value: Readonly<Record<string, unknown>>, message: string) => void;
}

export class ManagementService {
    readonly #authentication: AuthenticationService;
    readonly #managedBots: ManagedBotStorage;
    readonly #mobiusApp: MobiusAppService;
    readonly #platformProjects: PlatformProjectStorage;
    readonly #platform: PlatformProjectGateway;
    readonly #logger: AuditLogger;
    readonly #scopeProject: (projectId: string, signal: AbortSignal) => Promise<ManagementService>;

    constructor(cx: {
        readonly services: { readonly authentication: AuthenticationService; readonly mobiusApp: MobiusAppService };
        readonly storages: {
            readonly managedBots: ManagedBotStorage;
            readonly platformProjects: PlatformProjectStorage;
        };
        readonly gateways: { readonly platformProjects: PlatformProjectGateway };
        readonly logger: AuditLogger;
        readonly scopeProject: (projectId: string, signal: AbortSignal) => Promise<ManagementService>;
    }) {
        this.#authentication = cx.services.authentication;
        this.#managedBots = cx.storages.managedBots;
        this.#mobiusApp = cx.services.mobiusApp;
        this.#platformProjects = cx.storages.platformProjects;
        this.#platform = cx.gateways.platformProjects;
        this.#logger = cx.logger;
        this.#scopeProject = cx.scopeProject;
    }

    readonly createAnonymousUser = async (location: LocationHint, signal: AbortSignal) => {
        const userId = `usr_${crypto.randomUUID()}`;
        const project = await this.#platform.create(userId, "Personal workspace", signal, location);
        const scoped = await this.#scopeProject(project.projectId, signal);
        return await scoped.initializeAnonymousUser(userId, project, signal);
    };

    readonly initializeAnonymousUser = async (userId: string, project: PlatformProject, signal: AbortSignal) => {
        const identity = await this.#authentication.createAnonymous(userId, project.projectId, signal);
        const { origin, appId } = this.#platform.configuration();
        await this.#platformProjects.save(userId, origin, appId, project, signal);
        const bot = await this.provisionUserBot(identity.userId, undefined, signal);
        return { ...identity, bot };
    };

    readonly provisionUserBot = async (userId: string, location: LocationHint, signal: AbortSignal) => {
        const existing = (await this.#managedBots.listBots(userId, signal))[0];
        if (existing !== undefined) {
            return existing;
        }
        const { origin, appId } = this.#platform.configuration();
        const project =
            (await this.#platformProjects.read(userId, origin, appId, signal)) ??
            (await this.#platform.create(userId, "Personal workspace", signal, location));
        await this.#platformProjects.save(userId, origin, appId, project, signal);
        const bot = await this.#platform.createBot(project.projectId, signal);
        await this.#managedBots.saveClaim(userId, bot, Date.now(), signal);
        this.#logger.info({ event: "user-bot-created", userId, botId: bot.botId }, "Bot audit event");
        return bot;
    };

    readonly listBots = async (userId: string, location: LocationHint, signal: AbortSignal) => {
        await this.provisionUserBot(userId, location, signal);
        return await this.#managedBots.listBots(userId, signal);
    };

    readonly claimBot = async (
        userId: string,
        input: { readonly botId: string; readonly displayName: string; readonly ownerCredential: string },
        signal: AbortSignal,
    ) => {
        const accessToken = await this.#mobiusApp.issueAccessToken(input.botId, input.ownerCredential, signal);
        try {
            await this.#managedBots.saveClaim(
                userId,
                { botId: input.botId, displayName: input.displayName },
                Date.now(),
                signal,
            );
        } finally {
            await this.#mobiusApp.revokeAccessToken(accessToken.accessTokenId, AbortSignal.timeout(10_000));
            signal.throwIfAborted();
        }
        return { botId: input.botId, displayName: input.displayName };
    };

    readonly regenerateAccessToken = async (userId: string, accessTokenId: string, signal: AbortSignal) => {
        if ((await this.#managedBots.accessTokenBot(userId, accessTokenId, signal)) === null) {
            throw new ManagementError("NOT_FOUND", "Not found.", 404);
        }
        return await this.#mobiusApp.regenerateAccessToken(accessTokenId, signal);
    };

    readonly readProject = async (userId: string, signal: AbortSignal) => {
        const { origin, appId } = this.#platform.configuration();
        return await this.#platformProjects.read(userId, origin, appId, signal);
    };

    readonly createProject = async (
        userId: string,
        displayName: string,
        location: LocationHint,
        signal: AbortSignal,
    ) => {
        const { origin, appId } = this.#platform.configuration();
        const existing = await this.#platformProjects.read(userId, origin, appId, signal);
        if (existing !== null) {
            return existing;
        }
        const project = await this.#platform.create(userId, displayName, signal, location);
        const scoped = await this.#scopeProject(project.projectId, signal);
        await scoped.#platformProjects.save(userId, origin, appId, project, signal);
        this.#logger.info(
            { event: "platform-project-provisioned", userId, projectId: project.projectId },
            "Project audit event",
        );
        return (await scoped.#platformProjects.read(userId, origin, appId, signal)) ?? project;
    };

    readonly createRuntimePairing = async (userId: string, idempotencyKey: string, signal: AbortSignal) => {
        const project = await this.#requireProject(userId, signal);
        const pairing = await this.#platform.createPairing(project.projectId, idempotencyKey, signal);
        this.#logger.info(
            { event: "runtime-pairing-issued", userId, projectId: project.projectId, runtimeId: pairing.runtimeId },
            "Runtime audit event",
        );
        return pairing;
    };

    readonly readRuntimePairing = async (userId: string, pairingId: string, signal: AbortSignal) => {
        const project = await this.#requireProject(userId, signal);
        return await this.#platform.readPairing(project.projectId, pairingId, signal);
    };

    readonly createAgentPairing = async (token: string | undefined, botId: string, signal: AbortSignal) => {
        const session = await this.#authentication.session(token, signal);
        if (session.kind === "unavailable") {
            throw new ManagementError("AUTH_UNAVAILABLE", "Sign-in is temporarily unavailable.", 503);
        }
        if (session.kind === "unauthenticated") {
            throw new ManagementError("UNAUTHENTICATED", "Sign in to continue.", 401);
        }
        const bots = await this.#managedBots.listBots(session.session.userId, signal);
        if (!bots.some((bot) => bot.botId === botId)) {
            throw new ManagementError("BOT_NOT_FOUND", "Bot is unavailable.", 404);
        }
        return await this.#authentication.createPairing(session.session.userId, botId, signal);
    };

    readonly redeemAgentPairing = async (token: string, signal: AbortSignal) => {
        const identity = await this.#authentication.redeemPairing(token, signal);
        if (identity === null) {
            throw new ManagementError(
                "PAIRING_TICKET_UNAVAILABLE",
                "Copy a fresh pairing instruction from your Chat page.",
                410,
            );
        }
        const project = await this.readProject(identity.userId, signal);
        if (project === null) {
            throw new ManagementError("PROJECT_REQUIRED", "The Bot's Project is unavailable.", 409);
        }
        return { ...identity, projectId: project.projectId };
    };

    readonly #requireProject = async (userId: string, signal: AbortSignal) => {
        const project = await this.readProject(userId, signal);
        if (project === null) {
            throw new PlatformProjectError("PROJECT_REQUIRED", "Create your Project before pairing a Runtime.", 409);
        }
        return project;
    };
}
