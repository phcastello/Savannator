import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { parseCliArgs, printUsage } from "./cli.js";
import { createInteractionMeter } from "./interaction-meter.js";
import { createCommentRecyclePolicy, createPerformanceReporter, recyclePage } from "./page-health.js";

dotenv.config({ quiet: true });

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function validateCommentConfig({
  ACTION_LIMIT,
  COMMENT_TEXTS,
  COMMENT_PAGE_RECYCLE_EVERY,
  GIF_SEARCH_TERMS,
  INTERVAL_MS,
  RATE_LIMIT_FALLBACK_MS,
  TARGET_POST,
}) {
  const target = new URL(TARGET_POST);

  if (target.hostname !== "www.instagram.com" || !target.pathname.startsWith("/p/")) {
    throw new Error("TARGET_POST deve ser a URL de um post do Instagram.");
  }
  if (!Number.isFinite(INTERVAL_MS) || INTERVAL_MS <= 0) {
    throw new Error("INTERVAL_MS deve ser maior que zero.");
  }
  if (!Number.isInteger(ACTION_LIMIT) || ACTION_LIMIT <= 0) {
    throw new Error("ACTION_LIMIT deve ser um inteiro maior que zero.");
  }
  if (!Number.isSafeInteger(COMMENT_PAGE_RECYCLE_EVERY) || COMMENT_PAGE_RECYCLE_EVERY < 0) {
    throw new Error("COMMENT_PAGE_RECYCLE_EVERY deve ser um inteiro não negativo.");
  }
  if (!Number.isFinite(RATE_LIMIT_FALLBACK_MS) || RATE_LIMIT_FALLBACK_MS <= 0) {
    throw new Error("RATE_LIMIT_FALLBACK_MS deve ser maior que zero.");
  }
  if (!Array.isArray(GIF_SEARCH_TERMS) || GIF_SEARCH_TERMS.length === 0) {
    throw new Error("GIF_SEARCH_TERMS precisa ter pelo menos um termo.");
  }
  if (
    !Array.isArray(COMMENT_TEXTS) ||
    COMMENT_TEXTS.length === 0 ||
    COMMENT_TEXTS.some(
      (comment) => typeof comment !== "string" || comment.trim().length === 0,
    )
  ) {
    throw new Error(
      "COMMENT_TEXTS deve ser um array não vazio contendo somente strings não vazias.",
    );
  }
}

async function runCommentMode({ profile, show }) {
  const [config, browser, instagram, profileLockModule, scheduler] =
    await Promise.all([
      import("../config.js"),
      import("./browser.js"),
      import("./instagram.js"),
      import("./profile-lock.js"),
      import("./scheduler.js"),
    ]);

  const {
    ACTION_LIMIT,
    COMMENT_PAGE_RECYCLE_EVERY,
    INTERVAL_MS,
    RATE_LIMIT_FALLBACK_MS,
    TARGET_POST,
  } = config;
  const {
    getMainPage,
    hasCompletedInitialLogin,
    launchBrowser,
    markInitialLoginComplete,
  } = browser;
  const {
    AuthenticationRequiredError,
    ensureLoggedIn,
    isOnTargetPost,
    isLoggedIn,
    openInstagramHome,
    openTargetPost,
    performCommentAction,
    RateLimitError,
  } = instagram;
  const { acquireProfileLock, ProfileInUseError } = profileLockModule;
  const { runScheduler } = scheduler;
  const recyclePolicy = createCommentRecyclePolicy(COMMENT_PAGE_RECYCLE_EVERY);
  const performanceReporter = createPerformanceReporter("comment", { intervalMs: INTERVAL_MS });
  const interactionMeter = createInteractionMeter("comment");

  try {
    validateCommentConfig(config);
  } catch (error) {
    console.error(error.message);
    printUsage();
    process.exitCode = 1;
    return;
  }

  const profileDir = path.join(projectRoot, "profiles", profile);
  let profileLock;
  let context;
  let page;
  let targetNeedsNavigation = false;
  let shuttingDown = false;
  let showModeAnnounced = false;
  let recycleReason;
  const controller = new AbortController();

  const requestShutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nEncerrando...");
    controller.abort();
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    await context?.close().catch(() => {});
  };

  const onSigint = () => void requestShutdown("SIGINT");
  const onSigterm = () => void requestShutdown("SIGTERM");

  try {
    profileLock = await acquireProfileLock(profileDir, profile);
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);

    console.log(`Perfil: ${profile}`);
    console.log(`Diretório: profiles/${profile}`);

    const closeCurrentBrowser = async () => {
      const currentContext = context;
      context = undefined;
      page = undefined;
      await currentContext?.close().catch(() => {});
    };

    const openBrowser = async (headless) => {
      await closeCurrentBrowser();
      console.log(
        headless
          ? "\nAbrindo navegador em modo headless..."
          : "\nAbrindo navegador para autenticação...",
      );
      context = await launchBrowser(profileDir, { headless });
      page = await getMainPage(context);
      await openInstagramHome(page);
      recyclePolicy.resetPage();
      recycleReason = undefined;
    };

    const authenticateVisibly = async () => {
      await openBrowser(false);
      const authenticated = await ensureLoggedIn(page, {
        signal: controller.signal,
        announceExisting: true,
      });
      if (!authenticated) {
        await closeCurrentBrowser();
        return false;
      }

      await markInitialLoginComplete(profileDir);
      await closeCurrentBrowser();
      return true;
    };

    const startAuthenticatedHeadlessBrowser = async ({ firstRun = false } = {}) => {
      if (show) {
        if (!showModeAnnounced) {
          console.log("Modo --show: o navegador permanecerá visível durante toda a execução.");
          showModeAnnounced = true;
        }

        if (!page || page.isClosed()) await openBrowser(false);

        const authenticated = await ensureLoggedIn(page, {
          signal: controller.signal,
          announceExisting: true,
        });
        if (!authenticated) return false;

        await markInitialLoginComplete(profileDir);
        return true;
      }

      if (firstRun) {
        console.log("Primeira autenticação: o navegador será visível somente para o login.");
        if (!(await authenticateVisibly())) return false;
      }

      await openBrowser(true);
      if (await isLoggedIn(page)) {
        console.log("Sessão encontrada.");
        console.log("Conta autenticada.");
        return true;
      }

      console.log("Sessão expirada ou inválida.");
      console.log("A automação foi pausada para reautenticação manual.");
      if (!(await authenticateVisibly())) return false;
      if (controller.signal.aborted) return false;

      await openBrowser(true);
      if (!(await isLoggedIn(page))) {
        throw new Error(
          "O login foi detectado, mas a sessão não persistiu ao reiniciar em modo headless.",
        );
      }

      console.log("Sessão restaurada. Automação retomada em modo headless.");
      return true;
    };

    const firstRun = !(await hasCompletedInitialLogin(profileDir));
    if (!(await startAuthenticatedHeadlessBrowser({ firstRun }))) return;

    const ensureTargetPost = async () => {
      if (!targetNeedsNavigation && isOnTargetPost(page)) return true;

      targetNeedsNavigation = true;

      try {
        await openTargetPost(page);
        targetNeedsNavigation = false;
      } catch (error) {
        if (error instanceof RateLimitError) throw error;
        if (!(error instanceof AuthenticationRequiredError)) throw error;

        if (!(await startAuthenticatedHeadlessBrowser())) {
          if (controller.signal.aborted) return false;
          throw new Error("A reautenticação não foi concluída.");
        }
        if (!isOnTargetPost(page)) {
          await openTargetPost(page);
        }
        targetNeedsNavigation = false;
      }

      return true;
    };

    let pendingRateLimit;
    try {
      if (!(await ensureTargetPost())) return;
    } catch (error) {
      if (!(error instanceof RateLimitError)) throw error;
      pendingRateLimit = error;
    }
    console.log(`Post:\n${TARGET_POST}`);

    await runScheduler({
      intervalMs: INTERVAL_MS,
      actionLimit: ACTION_LIMIT,
      signal: controller.signal,
      action: async () => {
        if (pendingRateLimit) {
          const error = pendingRateLimit;
          pendingRateLimit = undefined;
          throw error;
        }

        const scheduledStarted = performance.now();
        if (!(await isLoggedIn(page))) {
          if (!(await startAuthenticatedHeadlessBrowser())) {
            if (controller.signal.aborted) return;
            throw new Error("A reautenticação não foi concluída.");
          }
        }

        if (!(await ensureTargetPost())) return;

        if (recycleReason) {
          const reason = recycleReason;
          recycleReason = undefined;
          try {
            const replacement = await recyclePage(context, page, async (candidate) => {
              await openTargetPost(candidate);
              if (!(await isLoggedIn(candidate)) || !isOnTargetPost(candidate)) {
                throw new Error("A nova Page não ficou autenticada no post alvo.");
              }
            });
            page = replacement;
            targetNeedsNavigation = false;
            recyclePolicy.recycled();
            console.log(`Page reciclada no mesmo BrowserContext (${reason}).`);
          } catch (error) {
            if (error instanceof RateLimitError) {
              recycleReason = reason;
              throw error;
            }
            recyclePolicy.failed();
            console.warn(`Falha ao reciclar a Page; mantendo a anterior: ${error.message}`);
          }
        }

        let timing;
        try {
          await performCommentAction(page, {
            debug: show,
            onTiming: (value) => { timing = value; },
          });
        } finally {
          if (timing) {
            timing.scheduledMs = performance.now() - scheduledStarted;
            await performanceReporter.record(page, timing).catch(() => {});
          }
        }
        interactionMeter.record();
        if (timing) recycleReason = recyclePolicy.recordSuccess(timing);
      },
    });
  } catch (error) {
    if (error instanceof ProfileInUseError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }

    if (!controller.signal.aborted) {
      console.error(`Erro: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    controller.abort();
    await context?.close().catch(() => {});
    await profileLock?.release().catch((error) => {
      console.error(`Não foi possível remover o lock: ${error.message}`);
      process.exitCode = 1;
    });
  }
}

async function main() {
  let options;

  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    printUsage();
    process.exitCode = 1;
    return;
  }

  try {
    if (options.mode === "reply") {
      if (options.replyDriver === "browser") {
        const { runBrowserReplyMode } = await import("./reply-browser-mode.js");
        await runBrowserReplyMode(options);
        return;
      }

      const { runReplyMode } = await import("./reply-mode.js");
      await runReplyMode(options);
      return;
    }

    await runCommentMode(options);
  } catch (error) {
    console.error(`Erro: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}

await main();
