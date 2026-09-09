import * as v from "valibot";

export { BotConnectionActor, RuntimeRelay, SessionRelay } from "../../worker/do/mobius-relays.ts";

// Stateful stand-in for the external placement authority in the local runtime.
export class TenantPlacementAllocator {
    readonly #placements = new Map([
        ["org_apac", { d1ShardId: "apac-01", r2BucketId: "apac", revision: 1 }],
        ["org_wnam", { d1ShardId: "wnam-01", r2BucketId: "wnam", revision: 1 }],
    ]);
    async fetch(request: Request): Promise<Response> {
        const { organizationId } = v.parse(v.object({ organizationId: v.string() }), await request.json());
        const placement = this.#placements.get(organizationId);
        return placement === undefined
            ? Response.json({ error: "not found" }, { status: 404 })
            : Response.json({ placement });
    }
}

export { default } from "../../worker/application.ts";
