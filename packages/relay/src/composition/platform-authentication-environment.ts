import { ProjectAuthenticationError } from "@morty-build/relay-core";
import { PlatformAuthenticationConfiguration } from "../entity/platform-control-plane.ts";

export interface PlatformAuthenticationEnvironment {
    readonly MORTY_ALLOWED_ORIGINS: string;
}

export function platformAuthenticationFromEnvironment(
    environment: PlatformAuthenticationEnvironment,
): PlatformAuthenticationConfiguration {
    let value: unknown;
    try {
        value = JSON.parse(environment.MORTY_ALLOWED_ORIGINS);
    } catch (cause) {
        throw new ProjectAuthenticationError("relay_configuration_invalid", "The allowed origins are invalid", {
            cause,
        });
    }
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        throw new ProjectAuthenticationError("relay_configuration_invalid", "The allowed origins are invalid");
    }
    return new PlatformAuthenticationConfiguration(new Set(value.filter((entry) => typeof entry === "string")));
}
