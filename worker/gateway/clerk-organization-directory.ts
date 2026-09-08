import { createClerkClient } from "@clerk/backend";
import { isClerkAPIResponseError } from "@clerk/backend/errors";
import * as v from "valibot";
import { tenantPlacementMetadataSchema } from "../entity/tenant-placement.ts";
import type { OrganizationDirectory } from "../service/tenant-placement.ts";

function waitForBackend<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
        const abort = () => {
            signal.removeEventListener("abort", abort);
            reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        void operation()
            .then(resolve, (cause: unknown) => {
                if (signal.aborted) {
                    reject(signal.reason);
                } else {
                    reject(cause);
                }
            })
            .finally(() => signal.removeEventListener("abort", abort));
    });
}

export class ClerkOrganizationDirectory implements OrganizationDirectory {
    readonly #client: ReturnType<typeof createClerkClient>;

    constructor(cx: { readonly config: { readonly clerkSecretKey: string } }) {
        this.#client = createClerkClient({ secretKey: cx.config.clerkSecretKey });
    }

    readonly get = async (organizationId: string, signal: AbortSignal) => {
        try {
            const organization = await waitForBackend(
                () => this.#client.organizations.getOrganization({ organizationId }),
                signal,
            );
            return {
                id: organization.id,
                publicMetadata: organization.publicMetadata,
            };
        } catch (cause) {
            signal.throwIfAborted();
            if (isClerkAPIResponseError(cause) && cause.status === 404) {
                return null;
            }
            throw cause;
        }
    };

    readonly list = async (signal: AbortSignal) => {
        const organizations: {
            readonly id: string;
            readonly publicMetadata: unknown;
        }[] = [];
        const limit = 100;
        let offset = 0;
        while (true) {
            const page = await waitForBackend(
                () => this.#client.organizations.getOrganizationList({ limit, offset }),
                signal,
            );
            organizations.push(
                ...page.data.map((organization) => ({
                    id: organization.id,
                    publicMetadata: organization.publicMetadata,
                })),
            );
            offset += page.data.length;
            if (offset >= page.totalCount || page.data.length === 0) {
                return organizations;
            }
            signal.throwIfAborted();
        }
    };

    readonly create = async (
        input: {
            readonly createdBy: string;
            readonly name: string;
            readonly publicMetadata: unknown;
        },
        signal: AbortSignal,
    ) => {
        const metadata = v.parse(tenantPlacementMetadataSchema, input.publicMetadata);
        const organization = await waitForBackend(
            () =>
                this.#client.organizations.createOrganization({
                    createdBy: input.createdBy,
                    name: input.name,
                    publicMetadata: metadata,
                }),
            signal,
        );
        return {
            canDelete: organization.adminDeleteEnabled,
            id: organization.id,
            name: organization.name,
            publicMetadata: organization.publicMetadata,
        };
    };
}
