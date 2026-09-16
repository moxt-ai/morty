import type { OperationTiming } from "../../infra/operation-timing.ts";
import type { ManagementHttpEnvironment } from "../management/http/management-http-environment.ts";

export type ChatHttpEnvironment = Omit<ManagementHttpEnvironment, "Variables"> & {
    readonly Variables: ManagementHttpEnvironment["Variables"] & {
        readonly operationTiming: OperationTiming;
    };
};
