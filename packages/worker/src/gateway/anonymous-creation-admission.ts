import * as v from "valibot";
import { ManagementError } from "../components/management/entity/management-error.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";

const limiterSchema = v.custom<Pick<RateLimit, "limit">>(
    (value) => typeof value === "object" && value !== null && "limit" in value && typeof value.limit === "function",
);
const decisionSchema = v.object({ success: v.boolean() });

export async function admitAnonymousCreation(request: Request, bindings: CloudBindings): Promise<void> {
    const unavailable = (cause?: unknown) =>
        new ManagementError(
            "IDENTITY_CREATION_UNAVAILABLE",
            "New connections are temporarily unavailable. Try again shortly.",
            503,
            { "Cache-Control": "no-store", "Retry-After": "60" },
            { cause },
        );
    const limiter = v.safeParse(limiterSchema, bindings.ANONYMOUS_CREATION_LIMITER);
    if (!limiter.success) {
        throw unavailable();
    }
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 5_000);
    const signal = AbortSignal.any([request.signal, deadline.signal]);
    const aborted = Promise.withResolvers<never>();
    const cancel = () => aborted.reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    try {
        signal.throwIfAborted();
        // Cloudflare overwrites this header at ingress; the bridge carries that trusted value, never a frame header.
        // Anonymous callers have no trusted account ID. Missing metadata shares a quota instead of bypassing it.
        const key = `anonymous-creation:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`;
        // The binding has no cancellation API; bound our wait and never provision after cancellation or failure.
        const result: unknown = await Promise.race([limiter.output.limit({ key }), aborted.promise]);
        signal.throwIfAborted();
        if (!v.parse(decisionSchema, result).success) {
            throw new ManagementError(
                "IDENTITY_CREATION_RATE_LIMITED",
                "Too many new connections. Wait a minute and try again.",
                429,
                { "Cache-Control": "no-store", "Retry-After": "60" },
            );
        }
    } catch (cause) {
        request.signal.throwIfAborted();
        if (cause instanceof ManagementError) {
            throw cause;
        }
        throw unavailable(cause);
    } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
    }
}
