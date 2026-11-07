import { PlatformControlPlaneError } from "../entity/platform-control-plane.ts";
import type { ResolvedRecordingPolicy } from "../entity/recording-policy.ts";
import type { RecordingPolicyStorage } from "../storage/recording-policy-storage.ts";

export class RecordingPolicyService {
    readonly #storage: RecordingPolicyStorage;
    constructor(storage: RecordingPolicyStorage) {
        this.#storage = storage;
    }
    readonly readProjectPolicy = async (projectId: string, signal: AbortSignal): Promise<ResolvedRecordingPolicy> => {
        const policy = await this.#storage.readProject(projectId, signal);
        if (policy === null) {
            throw new PlatformControlPlaneError(
                "recording_target_not_found",
                "The Recording policy target is unavailable",
                404,
            );
        }
        return policy;
    };
}
