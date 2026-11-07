import type { ProjectLocationHint } from "@morty-build/client/protocol";
import type { MortyCreatePlatformProjectRequest } from "../src/platform.ts";

const request: MortyCreatePlatformProjectRequest = {
    clientReference: "user-1",
    displayName: "Personal workspace",
    idempotencyKey: "project-1",
    locationHint: "wnam",
};

// @ts-expect-error Unsupported Project location hints must be rejected by SDK consumers.
const unsupportedLocationHint: ProjectLocationHint = "moon";

void request;
void unsupportedLocationHint;
