import type { Logger } from "pino";
import type { CloudBindings } from "../infra/cloud-bindings.ts";

type WorkerFetch = (request: Request, bindings: CloudBindings, context?: ExecutionContext) => Promise<Response>;

/** Who made a setup request: a person's browser, or the agent and the setup script it runs. */
export type SetupClient = "browser" | "agent";

/** The setup steps a new user passes, from fetching the instructions to opening Morty through the returned link. */
const funnelSteps = [
    { event: "setup_instructions_served", method: "GET", path: /^\/setup\.md$/u },
    { event: "setup_script_served", method: "GET", path: /^\/setup\.mjs$/u },
    { event: "identity_created", method: "POST", path: /^\/morty\/api\/identity\/anonymous-users$/u },
    {
        event: "sharing_link_issued",
        method: "POST",
        path: /^\/morty\/api(?:\/projects\/[^/]+)?\/identity\/transfers$/u,
    },
    {
        event: "sharing_link_redeemed",
        method: "POST",
        path: /^\/morty\/api(?:\/projects\/[^/]+)?\/identity\/transfers\/redeem$/u,
    },
] as const;

/**
 * Records a successful setup step as one structured log line, so launch traffic can be counted step by step in
 * Workers Logs. Events carry no user, project, or network identifiers: only the step and who made the request.
 */
export function recordSetupFunnelStep(logger: Logger, request: Request, response: Response, client: SetupClient) {
    if (!response.ok) {
        return;
    }
    const pathname = new URL(request.url).pathname;
    const step = funnelSteps.find((candidate) => candidate.method === request.method && candidate.path.test(pathname));
    if (step !== undefined) {
        logger.info({ event: step.event, client }, "Setup funnel step");
    }
}

/**
 * Records setup steps that arrive over HTTP. It wraps the whole Worker so cached instruction documents count too.
 * Browsers send `Sec-Fetch-Site` on every request, including typed navigations; Node's fetch, curl and agent tools
 * do not.
 */
export function withSetupFunnelEvents(next: WorkerFetch, logger: Logger): WorkerFetch {
    return async (request, bindings, context) => {
        const response = await next(request, bindings, context);
        recordSetupFunnelStep(logger, request, response, request.headers.has("Sec-Fetch-Site") ? "browser" : "agent");
        return response;
    };
}
