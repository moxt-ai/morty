import { createStore } from "zustand/vanilla";

/** Owns presentation of pairing instructions independently of connection and conversation lifetimes. */
export const createPairingDialogStore = () =>
    createStore<{
        readonly open: boolean;
        readonly show: () => void;
        readonly dismiss: () => void;
    }>()((set) => ({
        open: false,
        show: () => set({ open: true }),
        dismiss: () => set({ open: false }),
    }));
