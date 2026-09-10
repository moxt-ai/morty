import { createStore } from "zustand/vanilla";
import { type BotBinding, type ManagementRequests, managementError } from "../requests/management";

type DashboardState =
    | { readonly status: "loading" }
    | { readonly status: "error"; readonly message: string }
    | {
          readonly status: "ready";
          readonly bots: readonly { readonly id: string; readonly name: string; readonly binding: BotBinding }[];
      };

export interface DashboardStore {
    readonly state: DashboardState;
    readonly load: (signal: AbortSignal) => Promise<void>;
}

export const createDashboardStore = (requests: ManagementRequests) =>
    createStore<DashboardStore>()((set) => ({
        state: { status: "loading" },
        load: async (signal) => {
            set({ state: { status: "loading" } });
            try {
                const bots = await requests.listBots(signal);
                signal.throwIfAborted();
                set({ state: { status: "ready", bots } });
            } catch (error) {
                if (!signal.aborted) {
                    set({ state: { status: "error", message: managementError(error) } });
                }
            }
        },
    }));
