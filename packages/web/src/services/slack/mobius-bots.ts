import { useMemo } from "react";
import * as v from "valibot";
import { useMobiusSlackIdentity, useMobiusSlackUrl } from "@/components/slack/mobius-slack-context";
import { type BotSetup, type BotSetupInput, botSetupSchema } from "./bot-setup";
import { projectCredentialSchema, useProjectCredentials } from "./project-credentials";
import { request } from "./request";

const projectSchema = v.pipe(v.object({ projectId: v.string(), displayName: v.string() }), v.readonly());
const botSchema = v.pipe(
    v.object({
        botId: v.string(),
        displayName: v.string(),
        lifecycle: v.string(),
        setupStatus: v.optional(v.picklist(["not-configured", "requested", "approved", "unavailable", "revoked"])),
    }),
    v.readonly(),
);
type MobiusProject = v.InferOutput<typeof projectSchema>;
type ManagedMobiusBot = v.InferOutput<typeof botSchema>;
const pairingSchema = v.pipe(
    v.object({
        pairingId: v.string(),
        projectId: v.string(),
        pairingCode: v.string(),
        pollToken: v.string(),
        expiresAt: v.string(),
        relayUrl: v.pipe(v.string(), v.url()),
    }),
    v.readonly(),
);
type MobiusPairing = v.InferOutput<typeof pairingSchema>;
export interface MobiusBotsRequests {
    readonly getBotSetup: (projectId: string, botId: string, signal: AbortSignal) => Promise<BotSetup>;
    readonly configureBot: (
        projectId: string,
        botId: string,
        input: BotSetupInput,
        signal: AbortSignal,
    ) => Promise<BotSetup>;
    readonly canManageProject: (projectId: string) => boolean;
    readonly createPairing: (signal: AbortSignal) => Promise<MobiusPairing>;
    readonly pairingStatus: (pairing: MobiusPairing, signal: AbortSignal) => Promise<"pending" | "paired" | "expired">;
    readonly projectStatus: (projectId: string, signal: AbortSignal) => Promise<"connected" | "offline">;
    readonly listProjects: (signal: AbortSignal) => Promise<readonly MobiusProject[]>;
    readonly listBots: (projectId: string, signal: AbortSignal) => Promise<readonly ManagedMobiusBot[]>;
    readonly createBot: (
        projectId: string,
        input: { readonly displayName: string; readonly description: string },
        signal: AbortSignal,
    ) => Promise<ManagedMobiusBot>;
}

export function useMobiusBotsRequests(): MobiusBotsRequests {
    const { getToken } = useMobiusSlackIdentity();
    const resolve = useMobiusSlackUrl();
    const credentials = useProjectCredentials();
    return useMemo(
        () => ({
            getBotSetup: async (projectId, botId, signal) =>
                v.parse(
                    botSetupSchema,
                    await request(
                        resolve(
                            `/mobius-slack/api/slack/mobius/projects/${encodeURIComponent(projectId)}/bots/${encodeURIComponent(botId)}/setup/read`,
                        ),
                        getToken,
                        signal,
                        "POST",
                        { ownerCredential: credentials.require(projectId) },
                    ),
                ),
            configureBot: async (projectId, botId, input, signal) =>
                v.parse(
                    botSetupSchema,
                    await request(
                        resolve(
                            `/mobius-slack/api/slack/mobius/projects/${encodeURIComponent(projectId)}/bots/${encodeURIComponent(botId)}/setup`,
                        ),
                        getToken,
                        signal,
                        "POST",
                        { ...input, ownerCredential: credentials.require(projectId) },
                    ),
                ),
            canManageProject: (projectId) => credentials.read(projectId) !== null,
            createPairing: async (signal) => {
                const value = await request(
                    resolve("/mobius-slack/api/slack/mobius/pairings"),
                    getToken,
                    signal,
                    "POST",
                    {},
                );
                credentials.save(v.parse(projectCredentialSchema, value));
                return v.parse(pairingSchema, value);
            },
            pairingStatus: async (pairing, signal) =>
                v.parse(
                    v.object({ status: v.picklist(["pending", "paired", "expired"]) }),
                    await request(resolve("/mobius-slack/api/slack/mobius/pairings/status"), getToken, signal, "POST", {
                        pairingId: pairing.pairingId,
                        pollToken: pairing.pollToken,
                    }),
                ).status,
            projectStatus: async (projectId, signal) =>
                v.parse(
                    v.object({ status: v.picklist(["connected", "offline"]) }),
                    await request(
                        resolve(`/mobius-slack/api/slack/mobius/projects/${encodeURIComponent(projectId)}/status`),
                        getToken,
                        signal,
                    ),
                ).status,
            listProjects: async (signal: AbortSignal) =>
                v.parse(
                    v.object({ projects: v.array(projectSchema) }),
                    await request(resolve("/mobius-slack/api/slack/mobius/projects"), getToken, signal),
                ).projects,
            listBots: async (projectId: string, signal: AbortSignal) =>
                v.parse(
                    v.object({ bots: v.array(botSchema) }),
                    await request(
                        resolve(`/mobius-slack/api/slack/mobius/projects/${encodeURIComponent(projectId)}/bots`),
                        getToken,
                        signal,
                    ),
                ).bots,
            createBot: async (projectId, input, signal) =>
                v.parse(
                    botSchema,
                    await request(
                        resolve(`/mobius-slack/api/slack/mobius/projects/${encodeURIComponent(projectId)}/bots`),
                        getToken,
                        signal,
                        "POST",
                        { ...input, ownerCredential: credentials.require(projectId) },
                    ),
                ),
        }),
        [getToken, resolve, credentials],
    );
}
