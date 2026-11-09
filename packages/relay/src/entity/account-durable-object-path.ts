const accountPathPrefix = "/morty/internal/accounts/";

export interface AccountDurableObjectPath {
    readonly accountId: string;
    readonly requestPathname: string;
}

export function encodeAccountDurableObjectPath(accountId: string, requestPathname: string): string {
    return `${accountPathPrefix}${encodeURIComponent(accountId)}${requestPathname}`;
}

export function decodeAccountDurableObjectPath(pathname: string): AccountDurableObjectPath | null {
    if (!pathname.startsWith(accountPathPrefix)) {
        return null;
    }
    const accountPath = pathname.slice(accountPathPrefix.length);
    const separator = accountPath.indexOf("/");
    if (separator < 0) {
        return null;
    }
    try {
        return {
            accountId: decodeURIComponent(accountPath.slice(0, separator)),
            requestPathname: accountPath.slice(separator),
        };
    } catch {
        return null;
    }
}
