import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";
import application from "../../application.ts";
import type { CloudBindings } from "../../infra/cloud-bindings.ts";
import { DurableObjectDatabase } from "../../infra/durable-object-database.ts";
import { json } from "../../infra/http.ts";
import { cloudProjectId } from "../../middleware/project-context.ts";
import { platformIdentifier, platformProjectSchema } from "../management/entity/platform-project.ts";
import { projectRegion } from "../management/entity/project-region.ts";
import { consumeProjectQueueDelivery } from "../slack/composition/cloudflare-slack-worker.ts";
import { projectQueueDeliverySchema } from "../slack/infra/queue-message.ts";

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
        if (url.origin === "https://project.internal" && url.pathname === "/__project/queue") {
            return await this.#consumeQueue(request);
        }
        const projectId =
            (await cloudProjectId(request)) ??
            (url.pathname.startsWith("/mobius-slack/api/") ? (url.searchParams.get("projectId") ?? null) : null);
        if (projectId === null) {
            return json({ error: { code: "PROJECT_REQUIRED", message: "Project context is required." } }, 400);
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

    readonly #consumeQueue = async (request: Request): Promise<Response> => {
        const input: unknown = await request.json();
        const delivery = v.parse(projectQueueDeliverySchema, input);
        await this.#bindProject(delivery.message.projectId);
        const consumed = await consumeProjectQueueDelivery(delivery, this.#bindings(delivery.message.projectId));
        return new Response(null, { status: consumed ? 204 : 503 });
    };

    readonly #bindProject = async (projectId: string): Promise<void> => {
        const stored: unknown = await this.ctx.storage.get("project-id");
        if (stored === undefined) {
            await this.ctx.storage.put("project-id", projectId);
            return;
        }
        if (stored !== projectId) {
            throw new Error("Durable Object Project identity does not match the request.");
        }
    };

    readonly #bindings = (projectId: string): CloudBindings => ({
        ...this.env,
        ATTACHMENTS:
            projectRegion(projectId) === "apac" ? this.env.CHAT_ATTACHMENTS_APAC : this.env.CHAT_ATTACHMENTS_WNAM,
        CHAT_PROJECT_ID: projectId,
        DATABASE: this.#database,
    });
}
