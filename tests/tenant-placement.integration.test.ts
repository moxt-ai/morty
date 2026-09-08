import { expect, test } from "vitest";
import { createTenantPlacementHandler, type OrganizationDirectory } from "../worker/service/tenant-placement.ts";

class InMemoryOrganizationDirectory implements OrganizationDirectory {
    readonly #organizations: {
        readonly id: string;
        readonly publicMetadata: unknown;
    }[] = [];
    #nextId = 1;
    readonly listingStarted = Promise.withResolvers<void>();
    readonly #listingGate = Promise.withResolvers<void>();

    constructor(paused = false) {
        if (!paused) {
            this.#listingGate.resolve();
        }
    }

    readonly resume = (): void => this.#listingGate.resolve();

    readonly add = (id: string, publicMetadata: unknown): void => {
        this.#organizations.push({ id, publicMetadata });
    };

    readonly get = async (organizationId: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        return this.#organizations.find((organization) => organization.id === organizationId) ?? null;
    };

    readonly list = async (signal: AbortSignal) => {
        this.listingStarted.resolve();
        await this.#listingGate.promise;
        signal.throwIfAborted();
        return [...this.#organizations];
    };

    readonly create = async (
        input: {
            readonly createdBy: string;
            readonly name: string;
            readonly publicMetadata: unknown;
        },
        signal: AbortSignal,
    ) => {
        signal.throwIfAborted();
        const organization = {
            id: `org_created_${this.#nextId++}`,
            name: input.name,
            canDelete: true,
            publicMetadata: input.publicMetadata,
        };
        this.#organizations.push(organization);
        return organization;
    };
}

function placementRequest(name: string): Request {
    return new Request("https://tenant-placement.internal/create", {
        method: "POST",
        body: JSON.stringify({
            environment: "production",
            name,
            region: "apac",
            userId: "user_alice",
        }),
        headers: { "Content-Type": "application/json" },
    });
}

function lookupRequest(organizationId: string): Request {
    return new Request("https://tenant-placement.internal/resolve", {
        method: "POST",
        body: JSON.stringify({ environment: "production", organizationId }),
        headers: { "Content-Type": "application/json" },
    });
}

test("Given an allocation in progress, When a queued creation is cancelled, Then it stops waiting and existing tenant lookups remain available", async () => {
    const organizations = new InMemoryOrganizationDirectory(true);
    const placement = { d1ShardId: "apac-01", r2BucketId: "apac", revision: 1 };
    organizations.add("org_existing", { mobiusCloud: { placement } });
    const handler = createTenantPlacementHandler({ gateways: { organizations } });
    const first = handler.fetch(placementRequest("First"));
    await organizations.listingStarted.promise;
    const controller = new AbortController();
    const cancelled = handler.fetch(new Request(placementRequest("Cancelled"), { signal: controller.signal }));
    controller.abort();
    try {
        await expect(cancelled).rejects.toBe(controller.signal.reason);
        const lookup = await handler.fetch(lookupRequest("org_existing"));
        expect(await lookup.json()).toEqual({ placement });
    } finally {
        organizations.resume();
        await first;
    }
    const next = await handler.fetch(placementRequest("Next"));
    expect(await next.json()).toMatchObject({ id: "org_created_2", name: "Next" });
});

test("Given uneven regional assignments, When a user creates a tenant, Then its D1 shard is frozen to the least-used shard and its R2 bucket stays in that region", async () => {
    const organizations = new InMemoryOrganizationDirectory();
    const existingPlacement = {
        mobiusCloud: {
            placement: {
                d1ShardId: "apac-01",
                r2BucketId: "apac",
                revision: 1,
            },
        },
    };
    organizations.add("org_existing_1", existingPlacement);
    organizations.add("org_existing_2", existingPlacement);
    const placement = createTenantPlacementHandler({ gateways: { organizations } });

    const response = await placement.fetch(placementRequest("Research team"));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
        canDelete: true,
        id: "org_created_1",
        name: "Research team",
    });
    expect(await organizations.list(AbortSignal.timeout(1_000))).toContainEqual({
        id: "org_created_1",
        name: "Research team",
        canDelete: true,
        publicMetadata: {
            mobiusCloud: {
                placement: {
                    d1ShardId: "apac-02",
                    r2BucketId: "apac",
                    revision: 1,
                },
            },
        },
    });
});

test("Given concurrent tenant creations, When their placement is allocated, Then each creation observes the previous frozen assignment", async () => {
    const organizations = new InMemoryOrganizationDirectory();
    const placement = createTenantPlacementHandler({ gateways: { organizations } });

    const responses = await Promise.all([
        placement.fetch(placementRequest("First team")),
        placement.fetch(placementRequest("Second team")),
    ]);

    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    const created = await organizations.list(AbortSignal.timeout(1_000));
    expect(created.map((organization) => organization.publicMetadata)).toEqual([
        {
            mobiusCloud: {
                placement: {
                    d1ShardId: "apac-01",
                    r2BucketId: "apac",
                    revision: 1,
                },
            },
        },
        {
            mobiusCloud: {
                placement: {
                    d1ShardId: "apac-02",
                    r2BucketId: "apac",
                    revision: 1,
                },
            },
        },
    ]);
});

test("Given an assigned resource was removed from inventory, When another tenant is created, Then allocation stops before creating an inconsistent placement", async () => {
    const organizations = new InMemoryOrganizationDirectory();
    organizations.add("org_existing", {
        mobiusCloud: {
            placement: {
                d1ShardId: "retired-apac-01",
                r2BucketId: "apac",
                revision: 2,
            },
        },
    });
    const placement = createTenantPlacementHandler({ gateways: { organizations } });

    const response = await placement.fetch(placementRequest("Research team"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
        error: {
            code: "UNAVAILABLE",
            message: "Workspace creation is temporarily unavailable.",
        },
    });
    expect(await organizations.list(AbortSignal.timeout(1_000))).toHaveLength(1);
});

test("Given an existing Organization has no placement, When its trusted route is resolved, Then storage access is rejected", async () => {
    const organizations = new InMemoryOrganizationDirectory();
    organizations.add("org_legacy", {});
    const placement = createTenantPlacementHandler({ gateways: { organizations } });

    const response = await placement.fetch(lookupRequest("org_legacy"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "UNAVAILABLE" } });
});

test("Given an unknown Organization, When its trusted route is resolved, Then no legacy fallback is authorized", async () => {
    const placement = createTenantPlacementHandler({
        gateways: { organizations: new InMemoryOrganizationDirectory() },
    });

    const response = await placement.fetch(lookupRequest("org_unknown"));

    expect(response.status).toBe(404);
});
