import type { ApplicationContext } from "../../../composition/application-context.ts";
import type { OperationTiming } from "../../../infra/operation-timing.ts";
import type { RequestHeaders } from "../../../middleware/request-headers.ts";

export type ManagementHttpEnvironment = {
    readonly Bindings: ApplicationContext;
    readonly Variables: RequestHeaders & { readonly operationTiming?: OperationTiming };
};
