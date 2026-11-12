import type { ProjectLocationHint } from "@morty-build/client/protocol";
import type { ComputerManagement } from "./computer-management.ts";

export type AccountProvisioner = (
    reference: string,
    location: ProjectLocationHint,
    signal: AbortSignal,
) => Promise<ComputerManagement>;
