import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  RATE_LIMIT_FALLBACK_MS,
  TARGET_POST,
} from "../config.js";
import {
  getMainPage,
  hasCompletedInitialLogin,
  launchBrowser,
  markInitialLoginComplete,
} from "./browser.js";
import {
  AuthenticationRequiredError,
  ensureLoggedIn,
  isLoggedIn,
  isOnTargetPost,
  openInstagramHome,
  openTargetPost,
  RateLimitError,
} from "./instagram.js";
import {
  scanAndReplyToComments,
  waitForCommentsArea,
} from "./instagram-replies.js";
import { acquireProfileLock, ProfileInUseError } from "./profile-lock.js";
import { createInteractionMeter } from "./interaction-meter.js";
import { createPerformanceReporter, recyclePage, samplePageHealth } from "./page-health.js";
import { LedgerWriteError, loadReplyLedger } from "./reply-ledger.js";

dotenv.config({ quiet: true });

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }

    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);

    function onAbort() {
      clearTimeout(timeout);
      resolve(false);
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function requiredValue(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} deve ser configurado no arquivo .env.`);
  }
  return value;
}

export function loadBrowserReplyConfig(env = process.env) {
  const replyText = requiredValue(env, "REPLY_TEXT");
  const username = requiredValue(env, "INSTAGRAM_USERNAME")
    .trim()
    .replace(/^@+/, "");
  const scanIntervalMs = Number(env.REPLY_SCAN_INTERVAL_MS ?? 60_000);
  const replyIntervalMs = Number(env.REPLY_INTERVAL_MS ?? 3_000);
  const maxPerScan = Number(env.REPLY_MAX_PER_SCAN ?? 0);
  const pageRecycleEvery = Number(env.REPLY_PAGE_RECYCLE_EVERY ?? 100);
  let targetPost;

  try {
    targetPost = new URL(TARGET_POST);
  } catch {
    throw new Error("TARGET_POST deve ser uma URL válida do Instagram.");
  }

  if (!username) {
    throw new Error("INSTAGRAM_USERNAME deve identificar a conta autenticada.");
  }
  if (!Number.isFinite(scanIntervalMs) || scanIntervalMs <= 0) {
    throw new Error("REPLY_SCAN_INTERVAL_MS deve ser maior que zero.");
  }
  if (!Number.isSafeInteger(replyIntervalMs) || replyIntervalMs < 0) {
    throw new Error("REPLY_INTERVAL_MS deve ser um inteiro não negativo.");
  }
  if (!Number.isSafeInteger(maxPerScan) || maxPerScan < 0) {
    throw new Error("REPLY_MAX_PER_SCAN deve ser um inteiro não negativo.");
  }
  if (!Number.isSafeInteger(pageRecycleEvery) || pageRecycleEvery < 0) {
    throw new Error("REPLY_PAGE_RECYCLE_EVERY deve ser um inteiro não negativo.");
  }
  if (!Number.isFinite(RATE_LIMIT_FALLBACK_MS) || RATE_LIMIT_FALLBACK_MS <= 0) {
    throw new Error("RATE_LIMIT_FALLBACK_MS deve ser maior que zero.");
  }
  if (
    !["instagram.com", "www.instagram.com"].includes(targetPost.hostname) ||
    !targetPost.pathname.startsWith("/p/")
  ) {
    throw new Error("TARGET_POST deve ser a URL de um post do Instagram.");
  }

  return {
    replyIntervalMs,
    maxPerScan,
    pageRecycleEvery,
    rateLimitFallbackMs: RATE_LIMIT_FALLBACK_MS,
    replyText,
    scanIntervalMs,
    targetPost: TARGET_POST,
    username,
  };
}

function printSummary(stats, ledger) {
  console.log("\nVarredura concluída:\n");
  console.log(`Comentários analisados: ${stats.commentsAnalyzed}`);
  console.log(`Já processados pelo bot: ${stats.alreadyProcessed}`);
  console.log(`Replies enviadas: ${stats.repliesSent}`);
  console.log(`Comentários próprios: ${stats.ownComments}`);
  console.log(`Erros: ${stats.errors}`);
  console.log(`Total persistido no ledger: ${ledger.size}`);
}

export async function runBrowserReplyMode({ profile, show }) {
  let config;

  try {
    config = loadBrowserReplyConfig();
  } catch (error) {
    console.error(`Erro: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
    return;
  }

  const profileDir = path.join(projectRoot, "profiles", profile);
  const controller = new AbortController();
  let profileLock;
  let context;
  let page;
  let shuttingDown = false;
  let showModeAnnounced = false;
  let targetNeedsNavigation = true;
  let ledger;
  let repliesOnPage = 0;
  let lastReplyAt = 0;
  const performanceReporter = createPerformanceReporter("reply");
  const interactionMeter = createInteractionMeter("reply");

  const requestShutdown = async (signalName) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nEncerrando...");
    controller.abort();
    process.exitCode = signalName === "SIGINT" ? 130 : 143;
    await context?.close().catch(() => {});
  };

  const onSigint = () => void requestShutdown("SIGINT");
  const onSigterm = () => void requestShutdown("SIGTERM");

  try {
    profileLock = await acquireProfileLock(profileDir, profile);
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);

    console.log("Modo: reply");
    console.log("Driver: browser");
    console.log(`Perfil: ${profile}`);
    console.log(`Conta: @${config.username}`);
    console.log(`Post: ${config.targetPost}`);
    console.log(`Diretório: profiles/${profile}`);
    ledger = await loadReplyLedger({
      stateDir: path.join(projectRoot, "state"),
      profile,
      targetPost: config.targetPost,
    });
    console.log(`Ledger carregado: ${ledger.size} comentários já processados.`);

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
      targetNeedsNavigation = true;
      repliesOnPage = 0;
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

    const startAuthenticatedBrowser = async ({ firstRun = false } = {}) => {
      if (show) {
        if (!showModeAnnounced) {
          console.log(
            "Modo --show: o navegador permanecerá visível durante toda a execução.",
          );
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
        console.log(
          "Primeira autenticação: o navegador será visível somente para o login.",
        );
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

    const ensureTargetPost = async () => {
      if (!targetNeedsNavigation && isOnTargetPost(page)) return true;
      targetNeedsNavigation = true;

      try {
        await openTargetPost(page);
        targetNeedsNavigation = false;
      } catch (error) {
        if (error instanceof RateLimitError) throw error;
        if (!(error instanceof AuthenticationRequiredError)) throw error;

        if (!(await startAuthenticatedBrowser())) {
          if (controller.signal.aborted) return false;
          throw new Error("A reautenticação não foi concluída.");
        }
        if (!isOnTargetPost(page)) await openTargetPost(page);
        targetNeedsNavigation = false;
      }

      return true;
    };

    const firstRun = !(await hasCompletedInitialLogin(profileDir));
    if (!(await startAuthenticatedBrowser({ firstRun }))) return;

    while (!controller.signal.aborted) {
      console.log("\nIniciando varredura...");
      let delayMs = config.scanIntervalMs;

      try {
        if (!(await isLoggedIn(page))) {
          if (!(await startAuthenticatedBrowser())) {
            if (controller.signal.aborted) break;
            throw new Error("A reautenticação não foi concluída.");
          }
        }

        if (!(await ensureTargetPost())) break;

        await waitForCommentsArea(page, { signal: controller.signal });

        const remainingBeforeRecycle = config.pageRecycleEvery > 0
          ? Math.max(1, config.pageRecycleEvery - repliesOnPage)
          : 0;
        const maxPerScan = remainingBeforeRecycle > 0
          ? config.maxPerScan > 0
            ? Math.min(config.maxPerScan, remainingBeforeRecycle)
            : remainingBeforeRecycle
          : config.maxPerScan;

        const stats = await scanAndReplyToComments(page, {
          intervalMs: config.replyIntervalMs,
          maxPerScan,
          ledger,
          ownUsername: config.username,
          replyText: config.replyText,
          signal: controller.signal,
          initialLastReplyAt: lastReplyAt,
          onReply: async ({ durationMs, sentAt }) => {
            repliesOnPage += 1;
            lastReplyAt = sentAt;
            interactionMeter.record();
            await performanceReporter.record(page, { totalMs: durationMs }).catch(() => {});
          },
          onProgress: async (commentsAnalyzed) => {
            if (commentsAnalyzed % 100 !== 0) return;
            const health = await samplePageHealth(page);
            console.log(
              `Progresso do scan: ${commentsAnalyzed} comentários, ` +
                `DOM nodes ${health.nodes ?? "indisponível"}, ` +
                `heap renderer ${Number.isFinite(health.rendererHeap) ?
                  `${(health.rendererHeap / 1024 / 1024).toFixed(1)} MB` : "indisponível"}.`,
            );
          },
        });
        if (controller.signal.aborted) break;
        printSummary(stats, ledger);

        if (config.pageRecycleEvery > 0 && repliesOnPage >= config.pageRecycleEvery) {
          try {
            const replacement = await recyclePage(context, page, async (candidate) => {
              await openTargetPost(candidate);
              if (!(await isLoggedIn(candidate)) || !isOnTargetPost(candidate)) {
                throw new Error("A nova Page não ficou autenticada no post alvo.");
              }
            });
            page = replacement;
            repliesOnPage = 0;
            targetNeedsNavigation = false;
            console.log("Page reciclada no mesmo BrowserContext; continuando pelo ledger.");
            continue;
          } catch (error) {
            if (error instanceof RateLimitError) throw error;
            repliesOnPage = 0;
            console.warn(`Falha ao reciclar a Page; mantendo a anterior: ${error.message}`);
          }
        }

        // Cada scan começa com uma navegação nova para que comentários
        // publicados depois do scan anterior também apareçam no post antigo.
        targetNeedsNavigation = true;
      } catch (error) {
        if (error instanceof LedgerWriteError) {
          console.error(
            "Falha ao gravar o ledger. Uma reply pode ter sido enviada sem registro. " +
              "Corrija o armazenamento antes de reiniciar o bot.",
          );
          console.error(error.message);
          process.exitCode = 1;
          break;
        }

        if (controller.signal.aborted || error?.name === "AbortError") break;

        targetNeedsNavigation = true;

        if (error instanceof AuthenticationRequiredError) {
          console.warn("\nA sessão precisa ser autenticada novamente.");
          if (!(await startAuthenticatedBrowser())) {
            if (controller.signal.aborted) break;
            throw new Error("A reautenticação não foi concluída.");
          }
          continue;
        }

        if (error instanceof RateLimitError) {
          delayMs =
            Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0
              ? error.retryAfterMs
              : config.rateLimitFallbackMs;
          console.warn("\nO Instagram bloqueou ou limitou temporariamente a ação.");
          console.warn(
            `Nova tentativa somente após ${Math.ceil(delayMs / 1_000)} segundos.`,
          );
        } else {
          console.error(
            `\nFalha na varredura: ${error instanceof Error ? error.message : error}`,
          );
        }
      }

      console.log(
        `\nPróxima varredura em ${Math.ceil(delayMs / 1_000)} segundos.`,
      );
      if (!(await wait(delayMs, controller.signal))) break;
    }
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
