import { ComputerAuthenticationError } from "./relay/computer-authentication.ts";
import { RelayAuthenticationConfiguration } from "./relay/computer-management.ts";

export interface RelayAuthenticationEnvironment {
    readonly MORTY_ALLOWED_ORIGINS: string;
}

export function relayAuthenticationFromEnvironment(
    environment: RelayAuthenticationEnvironment,
): RelayAuthenticationConfiguration {
    let value: unknown;
    try {
        value = JSON.parse(environment.MORTY_ALLOWED_ORIGINS);
    } catch (cause) {
        throw new ComputerAuthenticationError("relay_configuration_invalid", "The allowed origins are invalid", {
            cause,
        });
    }
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        throw new ComputerAuthenticationError("relay_configuration_invalid", "The allowed origins are invalid");
    }
    return new RelayAuthenticationConfiguration(new Set(value.filter((entry) => typeof entry === "string")));
}
