export class ClockService {
    readonly nowEpochMilliseconds = (): number => Date.now();
    readonly nowEpochSeconds = (): number => Math.floor(Date.now() / 1_000);
}
