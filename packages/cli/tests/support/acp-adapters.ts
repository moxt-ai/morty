import type { AdapterResolver } from "../../src/engine/acp/native-history/preview-contract.ts";
import { ControlledAcpAdapter } from "./controlled-acp-adapter.ts";

/** Routes every agent through the ACP preview, for agents that have no harness adapter. */
export const acpAdapters: AdapterResolver = (agent, dependencies) => new ControlledAcpAdapter(agent, dependencies);
