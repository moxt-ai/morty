export const MORTY_API_PREFIX = "/morty/api";
export function mortyApiUrl(origin: string | URL, resourcePath: `/${string}`): URL {
    return new URL(`${MORTY_API_PREFIX}${resourcePath}`, origin);
}
