import type { TenantShardingDirectory } from "@moxt-ai/mobius-relay-cloudflare/adapters";
import { PairingDirectoryError } from "@moxt-ai/mobius-relay-core";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import { CloudTenantShardingDirectory } from "./cloud-tenant-sharding-directory.ts";

export class MobiusTenantShardingDirectory implements TenantShardingDirectory {
    readonly #tenants: CloudTenantShardingDirectory;

    constructor(cx: { readonly config: { readonly bindings: CloudBindings } }) {
        this.#tenants = new CloudTenantShardingDirectory(cx);
    }

    readonly resolve: TenantShardingDirectory["resolve"] = async (tenantId, signal) => {
        try {
            return await this.#tenants.resolve(tenantId, signal);
        } catch (cause) {
            signal.throwIfAborted();
            throw new PairingDirectoryError("directory_unavailable", "Workspace storage is unavailable", { cause });
        }
    };
}
