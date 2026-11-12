import type { ComputerLocationHint } from "./computer-location.ts";
import type { ComputerManagement } from "./computer-management.ts";

export type AccountProvisioner = (
    reference: string,
    location: ComputerLocationHint,
    signal: AbortSignal,
) => Promise<ComputerManagement>;
