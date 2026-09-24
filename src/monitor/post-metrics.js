import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function validateObservation(value, filename) {
  if (!value || typeof value !== "object" ||
      typeof value.checked_at !== "string" ||
      !Number.isFinite(Date.parse(value.checked_at)) ||
      new Date(value.checked_at).toISOString() !== value.checked_at) {
    throw new Error(`Horário UTC inválido em ${filename}.`);
  }
  if (!Number.isSafeInteger(value.count) || value.count < 0) {
    throw new Error(`Contagem deve ser um inteiro não negativo em ${filename}.`);
  }
  if (typeof value.method !== "string" || !value.method.trim()) {
    throw new Error(`Método de extração inválido em ${filename}.`);
  }
  return { checked_at: value.checked_at, count: value.count, method: value.method };
}

function sameObservation(a, b) {
  return a.count === b.count && a.method === b.method;
}

export function openPostMetrics(metricsRoot, posts, { appendFile = appendFileSync } = {}) {
  const series = new Map();
  const filenames = new Map();

  for (const [slug, post] of Object.entries(posts)) {
    if (!/^[a-z0-9_-]+$/.test(slug)) throw new Error(`Identificador de atlética inválido: ${slug}`);
    const folder = path.join(metricsRoot, slug);
    const metadataFile = path.join(folder, "post.json");
    const checksFile = path.join(folder, "checks.ndjson");
    mkdirSync(folder, { recursive: true });
    const expected = { schema_version: 1, name: post.name, post_url: post.postUrl, role: post.role };
    if (!existsSync(metadataFile)) writeFileSync(metadataFile, `${JSON.stringify(expected, null, 2)}\n`, { flag: "wx" });
    let actual;
    try { actual = JSON.parse(readFileSync(metadataFile, "utf8")); }
    catch { throw new Error(`Metadados inválidos em ${metadataFile}.`); }
    for (const key of Object.keys(expected)) {
      if (actual[key] !== expected[key]) throw new Error(`${key} não corresponde ao post em ${metadataFile}.`);
    }
    if (!existsSync(checksFile)) writeFileSync(checksFile, "", { flag: "wx" });
    const observations = new Map();
    const contents = readFileSync(checksFile, "utf8");
    if (contents && !contents.endsWith("\n")) throw new Error(`Linha final incompleta em ${checksFile}.`);
    for (const [index, line] of contents.split("\n").entries()) {
      if (!line) continue;
      let parsed;
      try { parsed = JSON.parse(line); }
      catch { throw new Error(`JSON inválido em ${checksFile}:${index + 1}.`); }
      const observation = validateObservation(parsed, checksFile);
      const old = observations.get(observation.checked_at);
      if (old && !sameObservation(old, observation)) {
        throw new Error(`Conflito de medição em ${checksFile}:${index + 1}.`);
      }
      observations.set(observation.checked_at, observation);
    }
    series.set(slug, observations);
    filenames.set(slug, checksFile);
  }

  function getSeries(slug) {
    const observations = series.get(slug);
    if (!observations) throw new Error(`Atlética desconhecida: ${slug}`);
    return [...observations.values()].sort((a, b) => a.checked_at.localeCompare(b.checked_at));
  }

  function append(slug, value) {
    const filename = filenames.get(slug);
    if (!filename) throw new Error(`Atlética desconhecida: ${slug}`);
    const observation = validateObservation(value, filename);
    const observations = series.get(slug);
    const old = observations.get(observation.checked_at);
    if (old) {
      if (sameObservation(old, observation)) return false;
      throw new Error(`Conflito de medição em ${filename}: ${observation.checked_at}.`);
    }
    appendFile(filename, `${JSON.stringify(observation)}\n`, "utf8");
    observations.set(observation.checked_at, observation);
    return true;
  }

  function addPair(check) {
    append("realeza", {
      checked_at: check.checked_at,
      count: check.target_count,
      method: check.target_method,
    });
    append("cacique", {
      checked_at: check.checked_at,
      count: check.rival_count,
      method: check.rival_method,
    });
  }

  function getPairs(targetSlug, rivalSlug) {
    const rivalByTime = new Map(getSeries(rivalSlug).map((item) => [item.checked_at, item]));
    return getSeries(targetSlug).flatMap((target) => {
      const rival = rivalByTime.get(target.checked_at);
      return rival ? [{
        checked_at: target.checked_at,
        target_count: target.count,
        rival_count: rival.count,
        target_method: target.method,
        rival_method: rival.method,
      }] : [];
    });
  }

  return { append, addPair, getSeries, getPairs };
}
