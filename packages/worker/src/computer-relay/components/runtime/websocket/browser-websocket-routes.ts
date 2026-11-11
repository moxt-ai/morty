import {
    CONTENT_WRITE_MAX_BYTES,
    decodeContentWriteCommand,
    type Identifier,
    isIdentifier,
    MORTY_API_PREFIX,
    type TurnState,
} from "@morty-build/client/protocol";
import * as v from "valibot";
import { toHttpError } from "../../../../contracts/http-error.ts";
import { PairingDirectoryError, validateIdentifier } from "../../../../contracts/relay/pairing.ts";
import { ComputerScope } from "../../../../contracts/relay/session.ts";
import { authorizeSessionContentUpload } from "../http/session-content-upload.ts";
import {
    decodeSessionRequest,
    interactionResponseRequest,
    sessionConfigurationRequest,
    sessionRenameRequest,
    turnSteerRequest,
    turnSubmissionRequest,
} from "../http/session-requests.ts";
import type { LocalSessionOperations } from "../service/local-session-operations.ts";
import type { SessionAccessService } from "../service/session-access-service.ts";
import type { TurnAdmission } from "../service/session-control.ts";
import { SessionControl } from "../service/session-control.ts";

type BrowserOperation =
    | {
          readonly kind:
              | "configuration-read"
              | "execution-read"
              | "turn-submit"
              | "configuration-write"
              | "rename"
              | "events";
      }
    | { readonly kind: "content-write" }
    | { readonly kind: "turn-steer" | "turn-withdraw" | "turn-cancel"; readonly turnId: Identifier }
    | { readonly kind: "interaction-respond"; readonly interactionId: Identifier };

const identifier = v.custom<Identifier>(isIdentifier);
const json = (value: unknown): Response => Response.json(value, { headers: { "Cache-Control": "no-store" } });
const notFound = (): Response =>
    Response.json(
        { error: { code: "not_found", message: "The requested Morty resource does not exist" } },
        { status: 404 },
    );

function decodeOperation(method: string, path: readonly string[]): BrowserOperation | null {
    const [resource, id, action] = path;
    if (path.length === 1) {
        switch (`${method} ${resource}`) {
            case "GET configuration":
                return { kind: "configuration-read" };
            case "GET active-turn":
                return { kind: "execution-read" };
            case "POST turns":
                return { kind: "turn-submit" };
            case "POST configuration":
                return { kind: "configuration-write" };
            case "POST rename":
                return { kind: "rename" };
            case "GET events-v2":
                return { kind: "events" };
        }
    }
    if (path.length === 2 && resource === "content" && method === "PUT") {
        return { kind: "content-write" };
    }
    if (path.length === 3 && resource === "turns") {
        switch (`${method} ${action}`) {
            case "PUT disposition":
                return { kind: "turn-steer", turnId: decodeSessionRequest(identifier, id) };
            case "POST cancel-before-start":
                return { kind: "turn-withdraw", turnId: decodeSessionRequest(identifier, id) };
            case "POST cancel":
                return { kind: "turn-cancel", turnId: decodeSessionRequest(identifier, id) };
        }
    }
    if (path.length === 3 && resource === "interactions" && action === "responses" && method === "POST") {
        return { kind: "interaction-respond", interactionId: decodeSessionRequest(identifier, id) };
    }
    return null;
}

/** Dispatches the existing browser WS envelopes internally. These paths are not HTTP endpoints. */
export function createBrowserWebSocketRoutes(ctx: {
    readonly computerId: string;
    readonly services: {
        readonly sessions: SessionAccessService;
        readonly operations: LocalSessionOperations;
    };
}) {
    const dispatch = async (request: Request): Promise<Response> => {
        const url = new URL(request.url);
        const prefix = `${MORTY_API_PREFIX}/v1/computers/`;
        const parts = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length).split("/") : [];
        if (parts[1] !== "harnesses" || parts[3] !== "sessions" || parts.length < 6) {
            return notFound();
        }
        const computerId = validateIdentifier(parts[0] ?? "", "computer_id");
        if (computerId !== ctx.computerId) {
            return Response.json({ error: { code: "runtime_access_denied" } }, { status: 403 });
        }
        const target = {
            harness: validateIdentifier(decodeURIComponent(parts[2] ?? ""), "harness"),
            sessionId: validateIdentifier(decodeURIComponent(parts[4] ?? ""), "session_id"),
        };
        const operation = decodeOperation(request.method, parts.slice(5).map(decodeURIComponent));
        if (operation === null) {
            return notFound();
        }
        const credential = (request.headers.get("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
        if (credential === undefined) {
            return Response.json(
                { error: { code: "session_access_required", message: "A Session credential is required" } },
                { status: 401 },
            );
        }
        const access = await ctx.services.sessions.authenticate(
            { kind: "session", computerId, target },
            credential,
            request.signal,
        );
        const scope = new ComputerScope(computerId);
        const control = new SessionControl(async (command) => {
            await access.authorize(request.signal);
            return ctx.services.operations.requestComputerScopeControl(scope, command, request.signal);
        }, target);
        switch (operation.kind) {
            case "content-write":
                return uploadContent(request, ctx.services);
            case "configuration-read":
                return json(await control.readConfiguration());
            case "execution-read": {
                const commandId = url.searchParams.get("commandId");
                return json(
                    await control.activeTurn(
                        commandId === null ? undefined : decodeSessionRequest(identifier, commandId),
                    ),
                );
            }
            case "turn-submit": {
                const input: unknown = await request.json();
                const body = decodeSessionRequest(turnSubmissionRequest, input);
                const accepted = await control.submitTurn({ ...body, commandId: body.idempotencyKey });
                const acceptedAt = new Date().toISOString();
                return json({
                    acceptedAt,
                    idempotencyKey: body.idempotencyKey,
                    request: {
                        content: body.content,
                        kind: "prompt",
                        sessionConfigurations: body.sessionConfigurations,
                    },
                    target,
                    state: submittedTurnState(accepted.state, acceptedAt),
                    turnId: accepted.commandId,
                });
            }
            case "turn-steer": {
                const input: unknown = await request.json();
                decodeSessionRequest(turnSteerRequest, input);
                await control.steerTurn(operation.turnId);
                return json({ turnId: operation.turnId });
            }
            case "turn-withdraw":
                await control.withdrawTurn(operation.turnId);
                return json({ turnId: operation.turnId });
            case "turn-cancel": {
                const { stopReason } = await control.cancelTurn(operation.turnId);
                return json({ turnId: operation.turnId, stopReason });
            }
            case "configuration-write": {
                const input: unknown = await request.json();
                return json(await control.configure(decodeSessionRequest(sessionConfigurationRequest, input)));
            }
            case "rename": {
                const input: unknown = await request.json();
                return json(await control.rename(decodeSessionRequest(sessionRenameRequest, input).title));
            }
            case "interaction-respond": {
                const input: unknown = await request.json();
                await control.respond(operation.interactionId, decodeSessionRequest(interactionResponseRequest, input));
                return json({ accepted: true });
            }
            case "events":
                await access.authorize(request.signal);
                if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
                    return ctx.services.operations.openPublicSessionEvents(
                        scope,
                        target,
                        {
                            signingKeyId: access.signingKeyId,
                            grant: access.grant,
                            expiresAt: access.expiresAtEpochMilliseconds,
                        },
                        request.signal,
                    );
                }
                return json(
                    await control.liveEvents({
                        cursor: decodeSessionRequest(
                            v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(512))),
                            url.searchParams.get("cursor"),
                        ),
                        eventLimit: decodeSessionRequest(
                            v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(10_000)),
                            Number(url.searchParams.get("limit") ?? "50"),
                        ),
                    }),
                );
        }
    };
    return async (request: Request): Promise<Response> => {
        request.signal.throwIfAborted();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), 30_000);
        const signal = AbortSignal.any([request.signal, controller.signal]);
        try {
            return await dispatch(new Request(request, { signal }));
        } catch (cause) {
            signal.throwIfAborted();
            const error = toHttpError(cause);
            return Response.json(error.body, {
                status: error.status,
                ...(error.headers === undefined ? {} : { headers: error.headers }),
            });
        } finally {
            clearTimeout(timer);
        }
    };
}

function submittedTurnState(state: TurnAdmission["state"], answeredAt: string): TurnState {
    switch (state) {
        case "queued":
            return { kind: "queued" };
        case "running":
            return { kind: "running", startedAt: answeredAt };
        case "settled":
            return {
                kind: "indeterminate",
                reconciliation: { detectedAt: answeredAt, reason: "dispatch_indeterminate" },
            };
    }
}

async function uploadContent(
    request: Request,
    dependencies: {
        readonly sessions: SessionAccessService;
        readonly operations: LocalSessionOperations;
    },
): Promise<Response> {
    const authorized = await authorizeSessionContentUpload(request, dependencies.sessions);
    if (authorized instanceof Response) {
        return authorized;
    }
    const { access, target, contentKey } = authorized;
    const byteLength = decodeSessionRequest(
        v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(CONTENT_WRITE_MAX_BYTES)),
        Number(request.headers.get("x-morty-byte-length") ?? ""),
    );
    const contentKind = decodeSessionRequest(
        v.picklist(["image", "resource"]),
        request.headers.get("x-morty-content-kind"),
    );
    const mediaType = decodeSessionRequest(
        v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
        request.headers.get("content-type"),
    );
    const encodedName = decodeSessionRequest(
        v.pipe(v.string(), v.minLength(1), v.maxLength(1_500)),
        request.headers.get("x-morty-file-name"),
    );
    const uri = decodeSessionRequest(
        v.pipe(v.string(), v.minLength(1), v.maxLength(4_096)),
        new URL(request.url).searchParams.get("uri"),
    );
    if (request.body === null) {
        throw new PairingDirectoryError("invalid_request", "The content body is required");
    }
    let name: string;
    try {
        name = decodeURIComponent(encodedName);
    } catch (cause) {
        throw new PairingDirectoryError("invalid_request", "The content name is invalid", { cause });
    }
    name = decodeSessionRequest(v.pipe(v.string(), v.minLength(1), v.maxLength(500)), name);
    const available = await dependencies.operations.writeProjectSessionContent(
        new ComputerScope(access.computerId),
        decodeContentWriteCommand(
            JSON.stringify({
                byteLength,
                contentKey,
                contentKind,
                kind: "content.write",
                mediaType,
                name,
                requestId: crypto.randomUUID(),
                target,
            }),
        ),
        request.body,
        request.signal,
    );
    return json({ byteLength, contentKey: available.contentKey, kind: contentKind, mimeType: mediaType, name, uri });
}
