import path from "node:path";
import { fileURLToPath } from "node:url";
import { TARGET_POST, RATE_LIMIT_FALLBACK_MS } from "../../config.js";
import {
  getMainPage, hasCompletedInitialLogin, launchBrowser, markInitialLoginComplete,
} from "../browser.js";
import {
  AuthenticationRequiredError, ensureLoggedIn, isLoggedIn, openInstagramHome, RateLimitError,
} from "../instagram.js";
import { acquireProfileLock } from "../profile-lock.js";
import { getPostCommentCount } from "./comment-count.js";
import { DEFAULT_COMPETITION_END_AT } from "./monitor-analytics.js";
import { createMonitorServer } from "./monitor-server.js";
import { collectPair, initialDelay, wait } from "./monitor-scheduler.js";
import { openMonitorStore } from "./monitor-store.js";
import { POSTS } from "./monitor-posts.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RETRY_MS = 5 * 60_000;

function postUrl(value, name) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${name} deve ser uma URL de post do Instagram.`); }
  if (parsed.protocol !== "https:" || parsed.hostname !== "www.instagram.com" || !/^\/p\/[^/]+\/?$/.test(parsed.pathname)) {
    throw new Error(`${name} deve ser uma URL de post do Instagram.`);
  }
  return parsed.href;
}

export function loadMonitorConfig(env = process.env) {
  const intervalMs = Number(env.MONITOR_INTERVAL_MS ?? 1_200_000);
  const port = Number(env.MONITOR_PORT ?? 3210);
  const endAt = env.MONITOR_END_AT ?? DEFAULT_COMPETITION_END_AT;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw new Error("MONITOR_INTERVAL_MS deve ser um inteiro positivo.");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("MONITOR_PORT deve estar entre 1 e 65535.");
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)$/.test(endAt) || !Number.isFinite(Date.parse(endAt))) {
    throw new Error("MONITOR_END_AT deve ser uma data ISO com fuso, como 2026-09-25T23:59:00-03:00.");
  }
  const config = {
    targetPost: postUrl(TARGET_POST, "TARGET_POST"),
    rivalPost: postUrl(env.MONITOR_RIVAL_POST ?? POSTS.cacique.postUrl, "MONITOR_RIVAL_POST"),
    intervalMs,
    port,
    endAt: new Date(endAt).toISOString(),
  };
  if (config.targetPost === config.rivalPost) throw new Error("TARGET_POST e MONITOR_RIVAL_POST devem ser posts diferentes.");
  if (config.targetPost !== POSTS.realeza.postUrl) throw new Error("TARGET_POST deve corresponder ao post da Realeza.");
  if (config.rivalPost !== POSTS.cacique.postUrl) throw new Error("MONITOR_RIVAL_POST deve corresponder ao post da Cacique.");
  return config;
}

export async function runMonitorMode({ profile, show }) {
  const config = loadMonitorConfig();
  const profileDir = path.join(root, "profiles", profile);
  const controller = new AbortController();
  let lock;
  let store;
  let dashboard;
  let context;
  let stopping = false;

  const closeBrowser = async () => {
    const current = context;
    context = undefined;
    await current?.close().catch(() => {});
  };
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    controller.abort();
    void closeBrowser();
  };

  const openBrowser = async (headless) => {
    await closeBrowser();
    context = await launchBrowser(profileDir, { headless });
    const page = await getMainPage(context);
    await openInstagramHome(page);
    return page;
  };
  const authenticateVisible = async () => {
    console.log("Aguardando autenticação manual no navegador visível...");
    const page = await openBrowser(false);
    const authenticated = await ensureLoggedIn(page, { signal: controller.signal, announceExisting: true });
    if (authenticated) await markInitialLoginComplete(profileDir);
    if (!show) await closeBrowser();
    else await page.goto("about:blank").catch(() => {});
    return authenticated;
  };
  const ensureBrowserSession = async () => {
    if (show) {
      if (!context) return authenticateVisible();
      const page = await context.newPage();
      try {
        await openInstagramHome(page);
        if (await isLoggedIn(page)) return true;
      } finally { await page.close().catch(() => {}); }
      return authenticateVisible();
    }
    if (!context && !(await hasCompletedInitialLogin(profileDir))) {
      if (!(await authenticateVisible())) return false;
    }
    let page = await openBrowser(true);
    if (await isLoggedIn(page)) {
      await page.goto("about:blank");
      return true;
    }
    await page.goto("about:blank").catch(() => {});
    console.log("Sessão expirada. Reautenticação manual necessária.");
    if (!(await authenticateVisible())) return false;
    if (controller.signal.aborted) return false;
    page = await openBrowser(true);
    const authenticated = await isLoggedIn(page);
    await page.goto("about:blank").catch(() => {});
    if (!authenticated) throw new Error("A sessão não persistiu após o login manual.");
    return true;
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    lock = await acquireProfileLock(profileDir, profile);
    store = openMonitorStore({ metricsRoot: path.join(root, "metrics"), stateDir: path.join(root, "state"), posts: POSTS });
    dashboard = createMonitorServer({ store, port: config.port, ...config });
    await dashboard.listen();
    console.log(`Monitor: http://127.0.0.1:${config.port}`);
    console.log(`Perfil: ${profile}; métricas: metrics/realeza e metrics/cacique`);
    if (!(await ensureBrowserSession())) return;

    let delay = initialDelay(store.getLatestCheck(), config.intervalMs);
    while (!controller.signal.aborted) {
      dashboard.setNextCheckAt(new Date(Date.now() + delay).toISOString());
      if (!(await wait(delay, controller.signal))) break;
      dashboard.setNextCheckAt(null);
      try {
        if (!context && !(await ensureBrowserSession())) break;
        let check;
        try {
          check = await collectPair({
            context, targetPost: config.targetPost, rivalPost: config.rivalPost,
            readCount: getPostCommentCount, store,
          });
        } catch (error) {
          if (!(error instanceof AuthenticationRequiredError)) throw error;
          console.log("Sessão expirada durante a coleta. Reautenticando...");
          if (!(await ensureBrowserSession())) break;
          check = await collectPair({
            context, targetPost: config.targetPost, rivalPost: config.rivalPost,
            readCount: getPostCommentCount, store,
          });
        }
        console.log(`Coleta ${check.checked_at}: TARGET ${check.target_count}; RIVAL ${check.rival_count}`);
        dashboard.broadcast();
        delay = initialDelay(check, config.intervalMs);
      } catch (error) {
        if (controller.signal.aborted) break;
        if (context && !context.browser()?.isConnected()) await closeBrowser();
        const message = error instanceof Error ? error.message : String(error);
        store.addError(new Date().toISOString(), message);
        console.error(`Falha na coleta: ${message}`);
        delay = error instanceof RateLimitError && Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0
          ? error.retryAfterMs
          : error instanceof RateLimitError ? RATE_LIMIT_FALLBACK_MS : RETRY_MS;
        dashboard.broadcast();
      }
    }
  } finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    controller.abort();
    await closeBrowser();
    await dashboard?.close();
    store?.close();
    await lock?.release();
  }
}
