import type { RequestHeaders } from "../../../middleware/request-headers.ts";
import type { SlackContext } from "../composition/create-dependencies";

export type SlackHttpEnvironment = { Bindings: SlackContext; Variables: RequestHeaders };
