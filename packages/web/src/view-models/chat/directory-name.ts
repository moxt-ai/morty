export function directoryName(directory: string): string {
    return (
        directory
            .replace(/[\\/]+$/u, "")
            .split(/[\\/]/u)
            .at(-1) || directory
    );
}
