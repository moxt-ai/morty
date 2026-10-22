import { useStore } from "zustand";

/**
 * The one sanctioned way views subscribe to an externally held store:
 * stores live outside React (in the application/workspace trees) and are
 * injected through props; this hook binds such a store to the rendering
 * view. Views never create or own store state themselves.
 */
export const useExternalStore = useStore;
