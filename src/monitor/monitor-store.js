import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openPostMetrics } from "./post-metrics.js";

export function openMonitorStore({ metricsRoot, stateDir, posts }) {
  const metrics = openPostMetrics(metricsRoot, posts);
  mkdirSync(stateDir, { recursive: true });
  const errorsFile = path.join(stateDir, "monitor-errors.ndjson");
  if (!existsSync(errorsFile)) writeFileSync(errorsFile, "", { flag: "wx" });
  let latestError = null;
  const contents = readFileSync(errorsFile, "utf8");
  if (contents && !contents.endsWith("\n")) throw new Error(`Linha final incompleta em ${errorsFile}.`);
  for (const [index, line] of contents.split("\n").entries()) {
    if (!line) continue;
    let error;
    try { error = JSON.parse(line); }
    catch { throw new Error(`JSON inválido em ${errorsFile}:${index + 1}.`); }
    if (typeof error.occurred_at !== "string" || typeof error.message !== "string") {
      throw new Error(`Erro de monitor inválido em ${errorsFile}:${index + 1}.`);
    }
    latestError = error;
  }

  return {
    addCheck(check) { metrics.addPair(check); },
    addError(at, message) {
      const error = { occurred_at: at, message };
      appendFileSync(errorsFile, `${JSON.stringify(error)}\n`, "utf8");
      latestError = error;
    },
    getChecks() { return metrics.getPairs("realeza", "cacique"); },
    getSeries(slug) { return metrics.getSeries(slug); },
    getLatestCheck() { return metrics.getPairs("realeza", "cacique").at(-1) ?? null; },
    getLatestError() { return latestError; },
    close() {},
  };
}
