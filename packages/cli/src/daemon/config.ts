export function resolveMaxAcpProcesses(environment: Readonly<NodeJS.ProcessEnv>): number {
    const configured = environment["MORTY_MAX_ACP_PROCESSES"];
    if (configured === undefined || configured === "") {
        return 1000;
    }
    const parsed = Number(configured);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("MORTY_MAX_ACP_PROCESSES must be a positive integer");
    }
    return parsed;
}
