import type { ComputerAccessService } from "../../management/service/computer-access-service.ts";
import type { ComputerSocketIdentity } from "./computer-service.ts";

type Access = (computerId: string) => Pick<ComputerAccessService, "activeGeneration" | "grantsSessionCredential">;

export class ComputerCredentialService {
    readonly #access: Access;

    constructor(access: Access) {
        this.#access = access;
    }

    /** A generation is active only while the object still holds the same computer's account. */
    readonly activeGeneration = async (
        identity: { readonly computerId: string },
        signal: AbortSignal,
    ): Promise<number | null> => {
        const generation = await this.#access(identity.computerId).activeGeneration(identity.computerId, signal);
        signal.throwIfAborted();
        return generation;
    };

    readonly authorizeViewer = async (
        identity: Extract<ComputerSocketIdentity, { readonly role: "viewer" }>,
        signal: AbortSignal,
    ): Promise<"granted" | "revoked"> =>
        (await this.#access(identity.computerId).grantsSessionCredential(
            identity.computerId,
            identity.credential.grant,
            signal,
        ))
            ? "granted"
            : "revoked";
}
