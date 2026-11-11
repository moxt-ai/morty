const computerPathPrefix = "/morty/internal/computers/";

export interface ComputerDurableObjectPath {
    readonly computerId: string;
    readonly requestPathname: string;
}

export function encodeComputerDurableObjectPath(computerId: string, requestPathname: string): string {
    return `${computerPathPrefix}${encodeURIComponent(computerId)}${requestPathname}`;
}

export function decodeComputerDurableObjectPath(pathname: string): ComputerDurableObjectPath | null {
    if (!pathname.startsWith(computerPathPrefix)) {
        return null;
    }
    const computerPath = pathname.slice(computerPathPrefix.length);
    const separator = computerPath.indexOf("/");
    if (separator < 0) {
        return null;
    }
    try {
        return {
            computerId: decodeURIComponent(computerPath.slice(0, separator)),
            requestPathname: computerPath.slice(separator),
        };
    } catch {
        return null;
    }
}
