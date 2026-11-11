// Lower-level contracts for hosting storage and domain modules. This entrypoint
// deliberately excludes application composition, services, and concrete gateways.
export * from "./entity/authentication/computer-authentication.ts";
export type { HttpError } from "./entity/http-error.ts";
export { PairingDirectoryError } from "./entity/pairing/pairing.ts";
export type { ComputerStorageDirectory } from "./infra/computer-storage-directory.ts";
export type * from "./infra/computer-store.ts";
