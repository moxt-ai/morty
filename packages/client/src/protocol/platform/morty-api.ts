export const MORTY_API_PREFIX = "/morty/api";
export const MORTY_API_VERSION = "1";

const API_PREFIX_PATTERN = /^\/[a-zA-Z0-9._~-]+(?:\/[a-zA-Z0-9._~-]+)*$/;

export class MortyApiConfigurationError extends Error {
    readonly code = "invalid_api_prefix";

    constructor() {
        super("The Morty API prefix must be an absolute path without parameters");
        this.name = "MortyApiConfigurationError";
    }
}

export function parseMortyApiPrefix(value: unknown): string {
    if (typeof value !== "string" || !API_PREFIX_PATTERN.test(value)) {
        throw new MortyApiConfigurationError();
    }
    return value;
}

export function mortyApiPath(resourcePath: `/${string}`, apiPrefix: string = MORTY_API_PREFIX): string {
    return `${parseMortyApiPrefix(apiPrefix)}${resourcePath}`;
}

export function mortyApiUrl(
    origin: string | URL,
    resourcePath: `/${string}`,
    apiPrefix: string = MORTY_API_PREFIX,
): URL {
    return new URL(mortyApiPath(resourcePath, apiPrefix), origin);
}
