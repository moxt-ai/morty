import * as v from "valibot";

const identifier = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u));
const botSchema = v.pipe(
    v.object({ botId: identifier, displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(80)) }),
    v.readonly(),
);

export type ManagedBot = v.InferOutput<typeof botSchema>;
const projectSchema = v.pipe(
    v.object({ projectId: identifier, displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(120)) }),
    v.readonly(),
);
export type ManagedProject = v.InferOutput<typeof projectSchema>;

export interface ManagementApiOptions {
    readonly projectId: string;
    readonly fetchRequest?: (request: Request) => Promise<Response>;
    readonly getToken: (signal: AbortSignal) => Promise<string | null>;
    readonly origin: string;
}

export class ManagementApi {
    readonly #fetchRequest: (request: Request) => Promise<Response>;
    readonly #getToken: (signal: AbortSignal) => Promise<string | null>;
    readonly #origin: string;
    readonly #projectId: string;
    constructor(options: ManagementApiOptions) {
        this.#fetchRequest = options.fetchRequest ?? ((request) => fetch(request));
        this.#getToken = options.getToken;
        this.#origin = options.origin;
        this.#projectId = v.parse(identifier, options.projectId);
    }

    readonly listBots = async (signal: AbortSignal): Promise<readonly ManagedBot[]> =>
        v.parse(v.object({ bots: v.array(botSchema) }), await this.#request("/bots", "GET", undefined, signal)).bots;

    readonly readProject = async (signal: AbortSignal): Promise<ManagedProject | null> =>
        v.parse(
            v.object({ project: v.nullable(projectSchema) }),
            await this.#request("/project", "GET", undefined, signal),
        ).project;

    readonly createProject = async (displayName: string, signal: AbortSignal): Promise<ManagedProject> =>
        v.parse(v.object({ project: projectSchema }), await this.#request("/project", "POST", { displayName }, signal))
            .project;

    readonly claimBot = async (
        input: { readonly botId: string; readonly displayName: string; readonly ownerCredential: string },
        signal: AbortSignal,
    ): Promise<ManagedBot> => v.parse(botSchema, await this.#request("/bots/claims", "POST", input, signal));

    readonly #request = async (
        path: string,
        method: "GET" | "POST",
        body: object | undefined,
        requestSignal: AbortSignal,
    ): Promise<unknown> => {
        const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(15_000)]);
        const token = await this.#getToken(signal);
        if (token === null) {
            throw new CloudApiError("UNAUTHENTICATED", "Sign in to continue.");
        }
        const response = await this.#fetchRequest(
            new Request(new URL(`/mobius-cloud/api/management${path}`, this.#origin), {
                method,
                signal,
                headers: {
                    authorization: `Bearer ${token}`,
                    "X-Mobius-Project-Id": this.#projectId,
                    ...(body === undefined ? {} : { "content-type": "application/json" }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
        );
        const value: unknown = await response.json();
        signal.throwIfAborted();
        if (!response.ok) {
            const parsed = v.safeParse(v.object({ error: v.object({ code: v.string(), message: v.string() }) }), value);
            throw new CloudApiError(
                parsed.success ? parsed.output.error.code : "MANAGEMENT_UNAVAILABLE",
                parsed.success ? parsed.output.error.message : "Bot management is unavailable.",
            );
        }
        return value;
    };
}

export class CloudApiError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
        super(message);
        this.code = code;
        this.name = "CloudApiError";
    }
}
