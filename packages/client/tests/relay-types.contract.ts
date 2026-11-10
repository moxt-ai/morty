import type { ProjectLocationHint } from "@morty-build/client/protocol";
import type { MortyCreateComputerManagementRequest } from "../src/relay.ts";

const request: MortyCreateComputerManagementRequest = {
    clientReference: "user-1",
    displayName: "Personal workspace",
    idempotencyKey: "project-1",
    locationHint: "wnam",
};

// @ts-expect-error Unsupported Project location hints must be rejected by SDK consumers.
const unsupportedLocationHint: ProjectLocationHint = "moon";

void request;
void unsupportedLocationHint;
