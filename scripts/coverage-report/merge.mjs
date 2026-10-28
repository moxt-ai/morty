import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import coverageLibrary from "istanbul-lib-coverage";
import reportLibrary from "istanbul-lib-report";
import reports from "istanbul-reports";

const root = new URL("../../", import.meta.url);

export async function mergeCoverage(reportNames, signal) {
    const coverage = coverageLibrary.createCoverageMap({});
    for (const name of reportNames) {
        const report = await readFile(new URL(`coverage/${name}/coverage-final.json`, root), {
            encoding: "utf8",
            signal,
        });
        const suite = coverageLibrary.createCoverageMap(JSON.parse(report));
        if (suite.files().length === 0) {
            throw new Error(`Empty coverage report: ${name}`);
        }
        coverage.merge(suite);
    }
    const context = reportLibrary.createContext({
        dir: fileURLToPath(new URL("coverage/", root)),
        coverageMap: coverage,
    });
    for (const format of ["text-summary", "json-summary", "lcovonly", "html"]) {
        signal.throwIfAborted();
        reports.create(format).execute(context);
    }
    const summary = coverage.getCoverageSummary();
    for (const metric of ["lines", "statements", "functions", "branches"]) {
        const { covered, total } = summary[metric];
        if (total === 0 || covered * 100 < total * 95) {
            console.warn(`${metric}: ${covered}/${total}; target 95% (informational)`);
        }
    }
}
