import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { TARGET_POST } from "../config.js";
import { parseCliArgs } from "../src/cli.js";
import { calculateAnalytics, theilSen } from "../src/monitor/monitor-analytics.js";
import { extractHydratedCommentCount, extractPostCommentCount, parseCommentCount } from "../src/monitor/comment-count.js";
import { createMonitorServer } from "../src/monitor/monitor-server.js";
import { collectPair, initialDelay } from "../src/monitor/monitor-scheduler.js";
import { openMonitorStore } from "../src/monitor/monitor-store.js";
import { loadMonitorConfig } from "../src/monitor/monitor-mode.js";
import { POSTS } from "../src/monitor/monitor-posts.js";
import { openPostMetrics } from "../src/monitor/post-metrics.js";
import { importLegacyChecks } from "../src/monitor/legacy-migration.js";

const HOUR = 3_600_000;
const base = Date.parse("2026-09-24T00:00:00.000Z");
const storeOptions = (dir) => ({ metricsRoot: path.join(dir, "metrics"), stateDir: path.join(dir, "state"), posts: POSTS });
const row = (hour, target, rival) => ({
  checked_at: new Date(base + hour * HOUR).toISOString(),
  target_count: target, rival_count: rival,
  target_method: "metadata", rival_method: "metadata",
});

test("CLI aceita monitor com profile e --show, rejeita driver reply", () => {
  assert.equal(parseCliArgs(["--mode", "monitor", "--profile", "monitor", "--show"]).show, true);
  assert.throws(() => parseCliArgs(["--mode", "monitor"]), /--profile/);
  assert.throws(() => parseCliArgs(["--mode", "monitor", "--profile", "monitor", "--reply-driver", "api"]), /--reply-driver/);
});

test("monitor usa intervalo padrão de 20 minutos e aceita configuração personalizada", () => {
  assert.equal(loadMonitorConfig({}).intervalMs, 20 * 60_000);
  assert.equal(loadMonitorConfig({ MONITOR_INTERVAL_MS: "600000" }).intervalMs, 600_000);
});

test("parsing aceita separadores de milhar e rejeita aproximações", () => {
  assert.equal(parseCommentCount("View all 47,535 comments"), 47_535);
  assert.equal(parseCommentCount("Ver todos os 47.535 comentários"), 47_535);
  assert.equal(parseCommentCount("1 234 567 comments"), 1_234_567);
  assert.equal(parseCommentCount("1.234.567 comentários"), 1_234_567);
  assert.equal(parseCommentCount("47.5K comments"), null);
  assert.equal(parseCommentCount("47,5 mil comentários"), null);
  assert.equal(parseCommentCount("1.2M comments"), null);
});

test("extração usa controles, aria e metadados sem contar comentários renderizados", async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (error) { t.skip(error.message); return; }
  try {
    const page = await browser.newPage();
    await page.setContent('<button>View all 47,535 comments</button><div>comment one</div>');
    assert.deepEqual(await extractPostCommentCount(page), { count: 47_535, method: "visible_comment_control" });
    await page.setContent('<button aria-label="Ver todos os 47.535 comentários">Abrir</button>');
    assert.deepEqual(await extractPostCommentCount(page), { count: 47_535, method: "aria_label" });
    await page.setContent('<meta property="og:description" content="47,535 Comments"><div>comentário</div>');
    assert.deepEqual(await extractPostCommentCount(page), { count: 47_535, method: "metadata" });
    await page.setContent('<span>View all 47,535 comments</span>');
    assert.deepEqual(await extractPostCommentCount(page), { count: 47_535, method: "visible_comment_text" });
    await page.setContent('<button>47.5K comments</button><div>comment one</div>');
    await assert.rejects(extractPostCommentCount(page), /exato indisponível/);
  } finally { await browser.close(); }
});

test("dados hidratados usam comment_count inteiro vinculado ao shortcode do post", async (t) => {
  const postUrl = "https://www.instagram.com/p/DdhsVOdTe42/";
  const related = { code: "OUTRO", comment_count: 12 };
  const main = { code: "DdhsVOdTe42", comment_count: 249_450 };
  const hydration = JSON.stringify({ require: [{ profile: { media: related }, xdt_api__v1__media__shortcode__web_info: { items: [main] } }] });
  assert.equal(extractHydratedCommentCount([hydration], postUrl), 249_450);
  assert.equal(extractHydratedCommentCount([JSON.stringify({ code: "OUTRO", comment_count: 8 })], postUrl), null);
  assert.equal(extractHydratedCommentCount([JSON.stringify({ code: "DdhsVOdTe42", comment_count: "249K" })], postUrl), null);
  let browser;
  try { browser = await chromium.launch(); } catch (error) { t.skip(error.message); return; }
  try {
    const page = await browser.newPage();
    await page.setContent(`<meta name="description" content="249K comments"><script type="application/json">${hydration}</script>`);
    assert.deepEqual(await extractPostCommentCount(page, postUrl), { count: 249_450, method: "hydrated_media" });
  } finally { await browser.close(); }
});

test("delta, Theil-Sen e gap preservam as unidades por hora", () => {
  const checks = [row(0, 100, 200), row(1, 112, 205), row(2, 124, 210), row(3, 136, 215)];
  const analytics = calculateAnalytics(checks);
  assert.deepEqual(analytics.delta, { target: 12, rival: 5, hours: 1 });
  assert.equal(analytics.gap, -79);
  assert.equal(analytics.gapSlope, 7);
  assert.equal(theilSen(checks, (x) => x.target_count), 12);
});

test("ETA só aparece com amostras suficientes e tendências compatíveis", () => {
  const crossing = Array.from({ length: 9 }, (_, i) => row(i, 100 + i * 100, 1000 + i * 20));
  const result = calculateAnalytics(crossing);
  assert.equal(result.forecast.status, "estimated");
  assert.equal(Math.round(result.forecast.hours * 100) / 100, 3.25);
  assert.equal(calculateAnalytics(crossing.slice(0, 4)).forecast.status, "estimated");
  assert.equal(calculateAnalytics(crossing.slice(0, 3)).forecast.status, "insufficient_data");
  const away = Array.from({ length: 9 }, (_, i) => row(i, 100 + i * 20, 1000 + i * 100));
  assert.equal(calculateAnalytics(away).forecast.status, "no_crossing");
  const conflicting = Array.from({ length: 20 }, (_, i) =>
    row(i, 1000 + (i < 12 ? i * 100 : 1100 - (i - 11) * 120), 1000));
  assert.equal(calculateAnalytics(conflicting).forecast.status, "unstable");
  const noisy = Array.from({ length: 9 }, (_, i) => row(i, 3000 - 1500 + i * 100 + (i % 2 ? 300 : -300), 3000));
  assert.equal(calculateAnalytics(noisy).forecast.status, "unstable");
});

test("previsão respeita 25/09/2026 às 23:59 em São Paulo", () => {
  const endAt = loadMonitorConfig({}).endAt;
  assert.equal(endAt, "2026-09-26T02:59:00.000Z");
  const before = [200, 300, 400, 500].map((target, i) => row(46 + i, target, 600));
  const after = [100, 200, 300, 400].map((target, i) => row(46 + i, target, 600));
  assert.equal(calculateAnalytics(before, { endAt, asOf: base + 49 * HOUR }).forecast.status, "estimated");
  assert.equal(calculateAnalytics(after, { endAt, asOf: base + 49 * HOUR }).forecast.status, "after_deadline");
  assert.equal(calculateAnalytics(before, { endAt, asOf: Date.parse(endAt) + 1 }).forecast.status, "ended");
});

test("histórico por post sobrevive ao restart e a agenda respeita o último par", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "savannator-monitor-"));
  try {
    let store = openMonitorStore(storeOptions(dir));
    store.addCheck(row(0, 100, 200));
    store.close();
    store = openMonitorStore(storeOptions(dir));
    assert.equal(store.getChecks().length, 1);
    assert.equal(initialDelay(store.getLatestCheck(), HOUR, base + HOUR / 2), HOUR / 2);
    assert.equal(initialDelay(store.getLatestCheck(), HOUR, base + HOUR + 1), 0);
    assert.equal(initialDelay(null, HOUR, base), 0);
    store.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("falha do RIVAL não insere comparação parcial e fecha a Page", async () => {
  const saved = [];
  let closed = false;
  const context = { newPage: async () => ({ close: async () => { closed = true; } }) };
  await assert.rejects(collectPair({ context, targetPost: "target", rivalPost: "rival",
    readCount: async (_page, url) => {
      if (url === "rival") throw new Error("sem contador");
      return { count: 10, method: "metadata" };
    }, store: { addCheck: (check) => saved.push(check) },
  }), /sem contador/);
  assert.equal(saved.length, 0);
  assert.equal(closed, true);
});

test("contagens não inteiras não entram no histórico", async () => {
  const saved = [];
  const context = { newPage: async () => ({ close: async () => {} }) };
  await assert.rejects(collectPair({ context, targetPost: "target", rivalPost: "rival",
    readCount: async (_page, url) => ({ count: url === "target" ? 100 : 47.5, method: "metadata" }),
    store: { addCheck: (check) => saved.push(check) },
  }), /não inteira/);
  assert.equal(saved.length, 0);
});

test("API mostra histórico e SSE publica atualização após nova amostra", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "savannator-monitor-server-"));
  const store = openMonitorStore(storeOptions(dir));
  const server = createMonitorServer({ store, port: 0, targetPost: "target", rivalPost: "rival", now: () => base });
  // Porta 0 é útil no teste; o servidor de produção valida 1..65535.
  await server.listen();
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const controller = new AbortController();
  let browser;
  try {
    let response = await fetch(`${baseUrl}/api/monitor`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).history.length, 0);
    response = await fetch(`${baseUrl}/api/monitor/events`, { signal: controller.signal });
    const reader = response.body.getReader();
    await reader.read(); // : connected
    browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => document.querySelector("#forecast")?.textContent === "Dados insuficientes");
    store.addCheck(row(0, 100, 200));
    server.broadcast();
    const event = new TextDecoder().decode((await reader.read()).value);
    assert.match(event, /event: update/);
    assert.match(event, /"target_count":100/);
    assert.equal((await (await fetch(`${baseUrl}/api/monitor`)).json()).history.length, 1);
    assert.equal((await fetch(`${baseUrl}/chart.js`)).status, 200);
    await page.waitForFunction(() => document.querySelector("#target-count")?.textContent === "100");
    assert.deepEqual(pageErrors, []);
    controller.abort();
  } finally { controller.abort(); await browser?.close(); await server.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("SSE avisa o dashboard ao chegar o encerramento", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "savannator-monitor-end-"));
  const store = openMonitorStore(storeOptions(dir));
  const endAt = new Date(Date.now() + 350).toISOString();
  const server = createMonitorServer({ store, port: 0, targetPost: "target", rivalPost: "rival", endAt });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    await server.listen();
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/monitor/events`, { signal: controller.signal });
    const reader = response.body.getReader();
    await reader.read();
    const event = new TextDecoder().decode((await reader.read()).value);
    assert.match(event, /event: update/);
    assert.match(event, /"status":"ended"/);
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("métricas ficam separadas por atlética e pares exigem horário comum", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "savannator-post-metrics-"));
  try {
    const metrics = openPostMetrics(dir, POSTS);
    const old = { checked_at: "2026-09-24T20:17:36.154Z", count: 667004, method: "hydrated_media" };
    assert.equal(metrics.append("cacique", old), true);
    assert.equal(metrics.append("cacique", old), false);
    assert.deepEqual(metrics.getPairs("realeza", "cacique"), []);
    const current = row(1, 100, 200);
    metrics.addPair(current);
    assert.deepEqual(metrics.getPairs("realeza", "cacique"), [current]);
    assert.equal(metrics.getSeries("cacique").length, 2);
    assert.equal(metrics.getSeries("realeza").length, 1);
    assert.equal(openPostMetrics(dir, POSTS).getSeries("cacique").length, 2);
    assert.equal(JSON.parse(readFileSync(path.join(dir, "cacique", "post.json"), "utf8")).post_url, POSTS.cacique.postUrl);
    assert.throws(() => openPostMetrics(dir, { ...POSTS, cacique: { ...POSTS.cacique, postUrl: "https://www.instagram.com/p/WRONG/" } }), /post_url/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("escrita interrompida mantém observação isolada fora da comparação", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "savannator-post-partial-"));
  try {
    const metrics = openPostMetrics(dir, POSTS, { appendFile: (filename, line) => {
      if (filename.includes("cacique")) throw new Error("disk full");
      appendFileSync(filename, line);
    } });
    await assert.rejects(async () => metrics.addPair(row(1, 100, 200)), /disk full/);
    const reopened = openPostMetrics(dir, POSTS);
    assert.equal(reopened.getSeries("realeza").length, 1);
    assert.equal(reopened.getSeries("cacique").length, 0);
    assert.deepEqual(reopened.getPairs("realeza", "cacique"), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("histórico inválido ou conflito de horário não é aceito", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "savannator-post-invalid-"));
  try {
    const metrics = openPostMetrics(dir, POSTS);
    const filename = path.join(dir, "cacique", "checks.ndjson");
    appendFileSync(filename, "{invalid}\n");
    assert.throws(() => openPostMetrics(dir, POSTS), /checks.ndjson/);
    await rm(filename);
    metrics.append("cacique", { checked_at: "2026-09-24T20:17:36.154Z", count: 10, method: "metadata" });
    appendFileSync(filename, JSON.stringify({ checked_at: "2026-09-24T20:17:36.154Z", count: 11, method: "metadata" }) + "\n");
    assert.throws(() => openPostMetrics(dir, POSTS), /conflito|conflict/i);
    assert.throws(() => metrics.append("realeza", { checked_at: "2026-09-24T20:17:36.154Z", count: 1.5, method: "metadata" }), /inteir|integer/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("migração copia Calango e Cacique uma vez sem alterar o SQLite original", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "savannator-legacy-metrics-"));
  try {
    const filename = path.join(dir, "old.sqlite");
    const db = new Database(filename);
    db.exec(`CREATE TABLE checks (
      id INTEGER PRIMARY KEY, checked_at TEXT NOT NULL, target_count INTEGER NOT NULL,
      rival_count INTEGER NOT NULL, target_method TEXT NOT NULL, rival_method TEXT NOT NULL
    ); CREATE TABLE errors (id INTEGER PRIMARY KEY, message TEXT NOT NULL);`);
    const insert = db.prepare("INSERT INTO checks (checked_at, target_count, rival_count, target_method, rival_method) VALUES (?, ?, ?, ?, ?)");
    insert.run("2026-09-24T13:17:08.505Z", 249603, 548382, "hydrated_media", "metadata");
    insert.run("2026-09-24T14:17:12.861Z", 256685, 562890, "metadata", "hydrated_media");
    db.prepare("INSERT INTO errors (message) VALUES (?)").run("legacy error");
    db.close();
    const metrics = openPostMetrics(path.join(dir, "metrics"), POSTS);
    assert.deepEqual(importLegacyChecks(filename, metrics), { importedCalango: 2, importedCacique: 2, totalLegacy: 2 });
    assert.deepEqual(importLegacyChecks(filename, metrics), { importedCalango: 0, importedCacique: 0, totalLegacy: 2 });
    const reopened = openPostMetrics(path.join(dir, "metrics"), POSTS);
    assert.deepEqual(reopened.getSeries("calango"), [
      { checked_at: "2026-09-24T13:17:08.505Z", count: 249603, method: "hydrated_media" },
      { checked_at: "2026-09-24T14:17:12.861Z", count: 256685, method: "metadata" },
    ]);
    assert.deepEqual(reopened.getSeries("cacique"), [
      { checked_at: "2026-09-24T13:17:08.505Z", count: 548382, method: "metadata" },
      { checked_at: "2026-09-24T14:17:12.861Z", count: 562890, method: "hydrated_media" },
    ]);
    assert.deepEqual(reopened.getSeries("realeza"), []);
    const source = new Database(filename, { readonly: true });
    assert.equal(source.prepare("SELECT count(*) AS n FROM checks").get().n, 2);
    assert.equal(source.prepare("SELECT message FROM errors").get().message, "legacy error");
    source.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("target global aponta para Realeza e monitor fixa Cacique na pasta correta", () => {
  assert.equal(TARGET_POST, POSTS.realeza.postUrl);
  assert.equal(loadMonitorConfig({}).rivalPost, POSTS.cacique.postUrl);
  assert.throws(() => loadMonitorConfig({ MONITOR_RIVAL_POST: POSTS.calango.postUrl }), /Cacique/);
});

test("painel mantém histórico antigo da Cacique sem misturá-lo na disputa nova", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "savannator-new-monitor-"));
  const metricsRoot = path.join(dir, "metrics");
  const seed = openPostMetrics(metricsRoot, POSTS);
  seed.append("cacique", { checked_at: "2026-09-24T20:17:36.154Z", count: 667004, method: "hydrated_media" });
  const store = openMonitorStore({ metricsRoot, stateDir: path.join(dir, "state"), posts: POSTS });
  store.addCheck(row(22, 300_000, 700_000));
  const server = createMonitorServer({ store, port: 0, targetPost: POSTS.realeza.postUrl, rivalPost: POSTS.cacique.postUrl });
  await server.listen();
  let browser;
  try {
    const snapshot = server.snapshot();
    assert.equal(snapshot.targetName, "Realeza");
    assert.equal(snapshot.rivalName, "Cacique");
    assert.equal(snapshot.series.rival.length, 2);
    assert.equal(snapshot.series.target.length, 1);
    assert.equal(snapshot.history.length, 1);
    assert.equal(snapshot.series.rival[0].count, 667004);
    assert.equal(snapshot.rivalStats.latest.count, 700_000);
    assert.equal(snapshot.analytics.latest.target_count, 300_000);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/monitor`);
    assert.equal((await response.json()).series.rival.length, 2);
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(baseUrl);
    await page.waitForFunction(() => document.querySelector("#target-count")?.textContent === "300.000");
    assert.match(await page.locator("body").innerText(), /Realeza/i);
    assert.match(await page.locator("body").innerText(), /Cacique/i);
    await page.locator('[data-range="all"]').click();
    assert.deepEqual(await page.evaluate(() => Chart.getChart(document.querySelector("#history-chart")).data.datasets.slice(0, 2).map((item) => item.data.length)), [1, 2]);
  } finally {
    await browser?.close();
    await server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
