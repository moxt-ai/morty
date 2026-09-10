import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";
import { ClerkOrganizationDirectory } from "../gateway/clerk-organization-directory.ts";
import { createTenantPlacementHandler } from "../service/tenant-placement.ts";

const allocatorBindingsSchema = v.object({
    CLERK_SECRET_KEY: v.pipe(v.string(), v.regex(/^sk_(test|live)_\S+$/u)),
    DEPLOY_ENVIRONMENT: v.picklist(["staging", "production"]),
});

interface AllocatorBindings {
    readonly CLERK_SECRET_KEY: unknown;
    readonly DEPLOY_ENVIRONMENT: unknown;
}

export class TenantPlacementAllocator extends DurableObject<AllocatorBindings> {
    readonly #handler: ReturnType<typeof createTenantPlacementHandler>;
    constructor(state: DurableObjectState, bindings: AllocatorBindings) {
        super(state, bindings);
        const configured = v.parse(allocatorBindingsSchema, bindings);
        const expectedPrefix = configured.DEPLOY_ENVIRONMENT === "production" ? "sk_live_" : "sk_test_";
        if (!configured.CLERK_SECRET_KEY.startsWith(expectedPrefix)) {
            throw new Error("Clerk instance does not match deployment environment.");
        }
        this.#handler = createTenantPlacementHandler({
            gateways: {
                organizations: new ClerkOrganizationDirectory({
                    config: { clerkSecretKey: configured.CLERK_SECRET_KEY },
                }),
            },
        });
    }
    override readonly fetch = async (request: Request): Promise<Response> => await this.#handler.fetch(request);
}
