export function pathDirectoryId(path: string): string {
    const bytes = new TextEncoder().encode(path);
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return `path-${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}`;
}
