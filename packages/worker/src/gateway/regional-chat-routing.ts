import { PlatformProjectError } from "../components/management/entity/platform-project.ts";
import { projectRegion } from "../components/management/entity/project-region.ts";
import { projectLocationHint } from "../components/management/http/project-location.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";

export async function routeRegionalChat(
    request: Request,
    bindings: CloudBindings,
    projectId: string | null,
): Promise<Response | null> {
    const region = bindings.MOBIUS_WORKER_REGION;
    if (region === undefined) {
        return null;
    }
    if (region !== "edge" && region !== "apac" && region !== "wnam") {
        throw new PlatformProjectError("REGIONAL_CONFIGURATION_INVALID", "Regional routing is unavailable.", 503);
    }
    const creating = new URL(request.url).pathname === "/mobius-cloud/api/identity/anonymous-users";
    if (projectId === null && !creating) {
        return null;
    }
    const destination = projectId === null ? (projectLocationHint(request) ?? "apac") : projectRegion(projectId);
    if (destination !== "apac" && destination !== "wnam") {
        throw new PlatformProjectError("REGIONAL_CONFIGURATION_INVALID", "Regional routing is unavailable.", 503);
    }
    if (region !== "edge") {
        if (projectId !== null && region !== destination) {
            throw new PlatformProjectError("PROJECT_REGION_MISMATCH", "The Project belongs to another region.", 421);
        }
        return null;
    }
    const target = destination === "apac" ? bindings.MOBIUS_REGIONAL_APAC : bindings.MOBIUS_REGIONAL_WNAM;
    if (typeof target !== "object" || target === null || !("fetch" in target) || typeof target.fetch !== "function") {
        throw new PlatformProjectError("REGIONAL_BACKEND_UNAVAILABLE", "Regional routing is unavailable.", 503);
    }
    request.signal.throwIfAborted();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 120_000);
    const signal = AbortSignal.any([request.signal, deadline.signal]);
    let abort = () => {};
    try {
        const response: unknown = await Promise.race([
            target.fetch(new Request(request, { signal })),
            new Promise<never>((_resolve, reject) => {
                abort = () => reject(signal.reason);
                signal.addEventListener("abort", abort, { once: true });
                if (signal.aborted) {
                    abort();
                }
            }),
        ]);
        signal.throwIfAborted();
        if (!(response instanceof Response)) {
            throw new PlatformProjectError("REGIONAL_BACKEND_UNAVAILABLE", "Regional routing is unavailable.", 503);
        }
        return response;
    } catch (cause) {
        request.signal.throwIfAborted();
        throw new PlatformProjectError(
            deadline.signal.aborted ? "REGIONAL_BACKEND_TIMEOUT" : "REGIONAL_BACKEND_UNAVAILABLE",
            "Regional routing is unavailable.",
            deadline.signal.aborted ? 504 : 503,
            { cause },
        );
    } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
    }
}
