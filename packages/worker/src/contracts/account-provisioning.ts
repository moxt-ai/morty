import type { ComputerManagement } from "./computer-management.ts";
import type { ProjectLocationHint } from "./project-location.ts";

export type AccountProvisioner = (
    reference: string,
    location: ProjectLocationHint,
    signal: AbortSignal,
) => Promise<ComputerManagement>;
