import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";
import application from "../../application.ts";
import type { CloudBindings } from "../../infra/cloud-bindings.ts";
import { DurableObjectDatabase } from "../../infra/durable-object-database.ts";
import { json } from "../../infra/http.ts";
import { cloudProjectId } from "../../middleware/project-context.ts";
import { platformIdentifier, platformProjectSchema } from "../management/entity/platform-project.ts";

const bootstrapSchema = v.pipe(v.object({ project: platformProjectSchema, userId: platformIdentifier }), v.readonly());

export class ProjectDurableObject extends DurableObject<CloudBindings> {
    readonly #database: DurableObjectDatabase;

    constructor(state: DurableObjectState, environment: CloudBindings) {
        super(state, environment);
        this.#database = new DurableObjectDatabase(state.storage);
    }

    override async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        if (url.origin === "https://project.internal" && url.pathname === "/__project/bootstrap") {
            return await this.#bootstrap(request);
        }
        const projectId = await cloudProjectId(request);
        if (projectId === null) {
            return json({ error: { code: "PROJECT_REQUIRED", message: "Morty context is required." } }, 400);
        }
        const validatedProjectId = v.parse(platformIdentifier, projectId);
        await this.#bindProject(validatedProjectId);
        return await application.fetch(request, this.#bindings(validatedProjectId));
    }

    readonly #bootstrap = async (request: Request): Promise<Response> => {
        const input: unknown = await request.json();
        const parsed = v.parse(bootstrapSchema, input);
        await this.#bindProject(parsed.project.projectId);
        return await application.fetch(
            new Request(request.url, {
                body: JSON.stringify(parsed),
                headers: { "content-type": "application/json" },
                method: "POST",
                signal: request.signal,
            }),
            this.#bindings(parsed.project.projectId),
        );
    };

    readonly #bindProject = async (projectId: string): Promise<void> => {
        const stored: unknown = await this.ctx.storage.get("project-id");
        if (stored === undefined) {
            await this.ctx.storage.put("project-id", projectId);
            return;
        }
        if (stored !== projectId) {
            throw new Error("Durable Object project identity does not match the request.");
        }
    };

    readonly #bindings = (projectId: string): CloudBindings => ({
        ...this.env,
        CHAT_PROJECT_ID: projectId,
        DATABASE: this.#database,
    });
}
