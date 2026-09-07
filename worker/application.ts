import { verifyToken } from "@clerk/backend";
import {
  createSlackApplication,
  createSlackWorker,
} from "@moxt-ai/app-slack-api";
import type { SlackQueueMessage } from "@moxt-ai/app-slack-api/infra";
import {
  CloudflareChannelRuntime,
  CloudflareSessionRuntime,
  D1PairingDirectory,
  sessionQuotaFromEnvironment,
} from "@moxt-ai/mobius-relay-cloudflare/adapters";
import { createMobiusApplication } from "@moxt-ai/mobius-relay-core";
import { z } from "zod";
import { SlackQueueController } from "../apps/slack/packages/worker/src/controller/slack-queue-controller.ts";
import {
  createCloudflareEnvironment,
  type WorkerBindings,
} from "../apps/slack/packages/worker/src/di/create-cloudflare-environment.ts";
import { publicConfigSchema, sessionSchema } from "../shared/contracts.ts";

const configurationSchema = z
  .object({
    CLERK_PUBLISHABLE_KEY: publicConfigSchema.unwrap().shape.publishableKey,
    CLERK_JWT_KEY: z.string().startsWith("-----BEGIN PUBLIC KEY-----"),
    APP_ORIGIN: z.url().refine((value) => {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && url.origin === value;
    }),
  })
  .readonly();

const claimsSchema = z
  .object({
    sub: z.string().startsWith("user_"),
    sid: z.string().startsWith("sess_"),
    sts: z.enum(["active", "pending"]).optional(),
    o: z
      .object({ id: z.string().startsWith("org_") })
      .readonly()
      .optional(),
  })
  .readonly();

interface CloudBindings {
  readonly AGENT_TRIGGER_RATE_LIMITER?: unknown;
  readonly APP_ORIGIN?: unknown;
  readonly ASSETS?: unknown;
  readonly ATTACHMENTS?: unknown;
  readonly AUTHENTICATION_BASE_URL?: unknown;
  readonly CLERK_ISSUER_URL?: unknown;
  readonly CLERK_JWT_KEY?: unknown;
  readonly CLERK_PUBLISHABLE_KEY?: unknown;
  readonly CLERK_SECRET_KEY?: unknown;
  readonly DATABASE?: unknown;
  readonly DIRECTORY_DATABASE?: unknown;
  readonly EVENTS?: unknown;
  readonly MOBIUS_BASE_URL?: unknown;
  readonly OAUTH_STATE_SIGNING_KEY?: unknown;
  readonly PUBLIC_BASE_URL?: unknown;
  readonly SERVICE_AUTH_TOKEN?: unknown;
  readonly RUNTIME_RELAY?: unknown;
  readonly SESSION_ACTIVE_SESSIONS_PER_PROJECT?: unknown;
  readonly SESSION_ACTIVE_SESSIONS_PER_TENANT?: unknown;
  readonly SESSION_RELAY?: unknown;
  readonly TOKEN_ENCRYPTION_KEY?: unknown;
}

interface MobiusBindings {
  readonly DIRECTORY_DATABASE: D1Database;
  readonly RUNTIME_RELAY: DurableObjectNamespace;
  readonly SESSION_ACTIVE_SESSIONS_PER_PROJECT?: string;
  readonly SESSION_ACTIVE_SESSIONS_PER_TENANT?: string;
  readonly SESSION_RELAY: DurableObjectNamespace;
}

const slackBindingsSchema = z.object({
  AGENT_TRIGGER_RATE_LIMITER: z.object({
    get: z.function(),
    idFromName: z.function(),
  }),
  ASSETS: z.object({ fetch: z.function() }),
  ATTACHMENTS: z.object({ get: z.function(), put: z.function() }),
  AUTHENTICATION_BASE_URL: z.url(),
  CLERK_ISSUER_URL: z.url(),
  CLERK_JWT_KEY: z.string(),
  CLERK_PUBLISHABLE_KEY: z.string(),
  CLERK_SECRET_KEY: z.string(),
  DATABASE: z.object({ batch: z.function(), prepare: z.function() }),
  EVENTS: z.object({ send: z.function() }),
  MOBIUS_BASE_URL: z.url(),
  OAUTH_STATE_SIGNING_KEY: z.string().min(1),
  PUBLIC_BASE_URL: z.url(),
  SERVICE_AUTH_TOKEN: z.string().min(1),
  TOKEN_ENCRYPTION_KEY: z.string().min(1),
});

function hasSlackBindings(
  bindings: CloudBindings,
): bindings is CloudBindings & WorkerBindings {
  return slackBindingsSchema.safeParse(bindings).success;
}

const mobiusBindingsSchema = z.object({
  DIRECTORY_DATABASE: z.object({ batch: z.function(), prepare: z.function() }),
  RUNTIME_RELAY: z.object({ get: z.function(), idFromName: z.function() }),
  SESSION_ACTIVE_SESSIONS_PER_PROJECT: z.string().optional(),
  SESSION_ACTIVE_SESSIONS_PER_TENANT: z.string().optional(),
  SESSION_RELAY: z.object({ get: z.function(), idFromName: z.function() }),
});

function hasMobiusBindings(
  bindings: CloudBindings,
): bindings is CloudBindings & MobiusBindings {
  return mobiusBindingsSchema.safeParse(bindings).success;
}

function isMobiusRequest(path: string): boolean {
  return (
    path === "/health" ||
    path === "/api/pairings" ||
    path.startsWith("/api/pairings/") ||
    path.startsWith("/api/channels/") ||
    path.startsWith("/api/projects/")
  );
}

function json(
  body: unknown,
  status = 200,
  headers?: Readonly<Record<string, string>>,
): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

function unauthenticated(): Response {
  return json(
    { error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } },
    401,
  );
}

const slackWorker = createSlackWorker<
  CloudBindings & WorkerBindings,
  ExecutionContext | undefined,
  MessageBatch<SlackQueueMessage>
>((bindings) => {
  const composition = createSlackApplication(
    createCloudflareEnvironment(bindings),
  );
  const injector = composition.create();
  return {
    fetchApi: async (request, environment, context) =>
      await injector
        .resolve("application")
        .fetch(request, environment, context),
    fetchFile: injector.resolve("slackFileController").fetch,
    consumeQueue: new SlackQueueController(
      injector.resolve("queueConsumer"),
      injector.resolve("logger"),
    ).consume,
  };
});

export default {
  async fetch(
    request: Request,
    bindings: CloudBindings,
    context?: ExecutionContext,
  ): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/mobius-slack/api/")) {
      if (!hasSlackBindings(bindings)) {
        return json(
          {
            error: {
              code: "SLACK_UNAVAILABLE",
              message: "Slack integration is temporarily unavailable.",
            },
          },
          503,
        );
      }
      return await slackWorker.fetch(request, bindings, context);
    }
    if (isMobiusRequest(path)) {
      if (!hasMobiusBindings(bindings)) {
        return json(
          {
            error: {
              code: "MOBIUS_UNAVAILABLE",
              message: "Mobius is temporarily unavailable.",
            },
          },
          503,
        );
      }
      const injector = createMobiusApplication({
        channelRuntime: new CloudflareChannelRuntime(bindings.RUNTIME_RELAY),
        pairingDirectory: new D1PairingDirectory(bindings.DIRECTORY_DATABASE),
        sessionRuntime: new CloudflareSessionRuntime(
          bindings.SESSION_RELAY,
          bindings.DIRECTORY_DATABASE,
          sessionQuotaFromEnvironment(bindings),
        ),
      });
      return await injector.resolve("application").fetch(request);
    }
    if (path !== "/api/config" && path !== "/api/session") {
      return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
    }
    if (request.method !== "GET") {
      return json(
        {
          error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." },
        },
        405,
        { Allow: "GET" },
      );
    }

    const configuration = configurationSchema.safeParse(bindings);
    if (path === "/api/config") {
      if (!configuration.success) {
        return json(
          {
            error: {
              code: "AUTH_UNAVAILABLE",
              message: "Sign-in is temporarily unavailable.",
            },
          },
          503,
        );
      }
      return json({ publishableKey: configuration.data.CLERK_PUBLISHABLE_KEY });
    }
    const token = request.headers
      .get("Authorization")
      ?.match(/^Bearer ([^\s]+)$/i)?.[1];
    if (token === undefined) {
      return unauthenticated();
    }
    if (!configuration.success) {
      return json(
        {
          error: {
            code: "AUTH_UNAVAILABLE",
            message: "Sign-in is temporarily unavailable.",
          },
        },
        503,
      );
    }

    request.signal.throwIfAborted();
    let verified: unknown;
    try {
      verified = await verifyToken(token, {
        jwtKey: configuration.data.CLERK_JWT_KEY,
        authorizedParties: [configuration.data.APP_ORIGIN],
      });
    } catch {
      return unauthenticated();
    }
    request.signal.throwIfAborted();
    const claims = claimsSchema.safeParse(verified);
    if (!claims.success || claims.data.sts === "pending") {
      return unauthenticated();
    }
    return json(
      sessionSchema.parse({
        userId: claims.data.sub,
        sessionId: claims.data.sid,
        organizationId: claims.data.o?.id ?? null,
      }),
    );
  },
  queue: async (batch, bindings) => {
    if (!hasSlackBindings(bindings)) {
      throw new Error("Slack queue configuration is unavailable.");
    }
    await slackWorker.queue(batch, bindings);
  },
} satisfies ExportedHandler<CloudBindings, SlackQueueMessage>;
