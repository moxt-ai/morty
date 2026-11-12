import type { CloudBindings } from "../../../../contracts/cloud-bindings.ts";
import type { ComputerTargetEnvironment } from "../../../../http/computer-target.ts";
import type { ApplicationContext } from "../../../composition/application-context.ts";
import type { RequestHeaders } from "../../../middleware/request-headers.ts";

export type ManagementHttpEnvironment = {
    readonly Bindings: CloudBindings;
    readonly Variables: RequestHeaders &
        ComputerTargetEnvironment["Variables"] & {
            readonly application: ApplicationContext;
            readonly signal: AbortSignal;
        };
};
