import dotenv from "dotenv";
import { TARGET_POST } from "../config.js";
import {
  createInstagramApiClient,
  formatInstagramApiError,
  InstagramApiError,
  InstagramCommentsUnavailableError,
  isAuthenticationApiError,
  isPermissionApiError,
} from "./instagram-api.js";

dotenv.config({ quiet: true });

class TargetPostNotFoundError extends Error {
  constructor(targetPost) {
    super(
      `O TARGET_POST não foi encontrado entre as mídias da conta autenticada: ${targetPost}`,
    );
    this.name = "TargetPostNotFoundError";
  }
}

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

export function loadReplyConfig(env = process.env) {
  const accessToken = requiredValue(env, "INSTAGRAM_ACCESS_TOKEN").trim();
  const userId = requiredValue(env, "INSTAGRAM_USER_ID").trim();
  const replyText = requiredValue(env, "REPLY_TEXT");
  const username = String(env.INSTAGRAM_USERNAME ?? "")
    .trim()
    .replace(/^@/, "");
  const graphApiVersion = String(env.GRAPH_API_VERSION ?? "v26.0").trim();
  const scanIntervalMs = Number(env.REPLY_SCAN_INTERVAL_MS ?? 60_000);
  let targetPost;

  try {
    targetPost = new URL(TARGET_POST);
  } catch {
    throw new Error("TARGET_POST deve ser uma URL válida do Instagram.");
  }

  if (!/^\d+$/.test(userId)) {
    throw new Error("INSTAGRAM_USER_ID deve conter somente números.");
  }
  if (!/^v\d+\.\d+$/.test(graphApiVersion)) {
    throw new Error('GRAPH_API_VERSION deve seguir o formato "v26.0".');
  }
  if (!Number.isFinite(scanIntervalMs) || scanIntervalMs <= 0) {
    throw new Error("REPLY_SCAN_INTERVAL_MS deve ser maior que zero.");
  }
  if (
    !["instagram.com", "www.instagram.com"].includes(targetPost.hostname) ||
    !targetPost.pathname.startsWith("/p/")
  ) {
    throw new Error("TARGET_POST deve ser a URL de um post do Instagram.");
  }

  return {
    accessToken,
    userId,
    username,
    graphApiVersion,
    replyText,
    scanIntervalMs,
    targetPost: TARGET_POST,
  };
}

function displayAuthor(comment) {
  const username = comment?.from?.username ?? comment?.username;
  return username ? `@${username}` : "@usuário-desconhecido";
}

function truncateComment(text, maximum = 160) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > maximum
    ? `${normalized.slice(0, maximum - 1)}…`
    : normalized;
}

function shouldInterruptScan(error) {
  return (
    error?.name === "AbortError" ||
    isAuthenticationApiError(error) ||
    isPermissionApiError(error) ||
    (error instanceof InstagramApiError && error.rateLimited)
  );
}

function logCommentError(error) {
  console.error("erro ao processar comentário:");
  console.error(formatInstagramApiError(error));
}

export async function runReplyScan({
  api,
  expectedCommentCount,
  mediaId,
  replyText,
  signal,
}) {
  const stats = {
    commentsFound: 0,
    alreadyReplied: 0,
    repliesSent: 0,
    ownCommentsIgnored: 0,
    errors: 0,
  };
  const processedComments = new Set();
  const comments = await api.getAllComments(mediaId, {
    expectedCount: expectedCommentCount,
    signal,
  });

  for (const comment of comments) {
    if (signal?.aborted) break;
    if (!comment?.id || processedComments.has(String(comment.id))) continue;

    const commentId = String(comment.id);
    processedComments.add(commentId);
    stats.commentsFound += 1;

    console.log(`\n${displayAuthor(comment)}`);
    console.log(`comentário: ${JSON.stringify(truncateComment(comment.text))}`);

    if (api.isOwnComment(comment)) {
      stats.ownCommentsIgnored += 1;
      console.log("status: comentário da própria conta → ignorado");
      continue;
    }

    try {
      console.log("status: verificando respostas existentes...");

      // Esta consulta completa e paginada acontece imediatamente antes do
      // POST. O Instagram, e não a memória local, decide a idempotência.
      if (await api.hasOwnReply(commentId, { mediaId, signal })) {
        stats.alreadyReplied += 1;
        console.log("status: já possui resposta → ignorado");
        continue;
      }

      if (signal?.aborted) break;

      console.log("status: sem resposta → enviando reply...");
      await api.replyToComment(commentId, replyText, { mediaId, signal });
      stats.repliesSent += 1;
      console.log("reply enviada");
    } catch (error) {
      if (shouldInterruptScan(error)) throw error;
      stats.errors += 1;
      logCommentError(error);
    }
  }

  return stats;
}

function printSummary(stats) {
  console.log("\nVarredura concluída:\n");
  console.log(`Comentários encontrados: ${stats.commentsFound}`);
  console.log(`Já respondidos: ${stats.alreadyReplied}`);
  console.log(`Respostas enviadas: ${stats.repliesSent}`);
  console.log(`Comentários próprios ignorados: ${stats.ownCommentsIgnored}`);
  console.log(`Erros: ${stats.errors}`);
}

export async function runReplyMode() {
  let config;

  try {
    config = loadReplyConfig();
  } catch (error) {
    console.error(`Erro: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
    return;
  }

  const controller = new AbortController();
  let shuttingDown = false;

  const requestShutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nEncerrando após a operação atual...");
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    controller.abort();
  };

  const onSigint = () => requestShutdown("SIGINT");
  const onSigterm = () => requestShutdown("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  const api = createInstagramApiClient({
    accessToken: config.accessToken,
    userId: config.userId,
    username: config.username,
    graphApiVersion: config.graphApiVersion,
  });

  console.log("Modo: reply");
  console.log(
    config.username ? `Conta: @${config.username}` : `Conta: ${config.userId}`,
  );
  console.log(`Post:\n${config.targetPost}`);

  try {
    let targetMediaId;
    let targetCommentCount;

    while (!controller.signal.aborted) {
      console.log("\nIniciando varredura...");
      let delayMs = config.scanIntervalMs;

      try {
        if (!targetMediaId) {
          const targetMedia = await api.getTargetMedia(config.targetPost, {
            signal: controller.signal,
          });
          if (!targetMedia?.id) {
            throw new TargetPostNotFoundError(config.targetPost);
          }
          targetMediaId = String(targetMedia.id);
          targetCommentCount = Number(targetMedia.comments_count);
          console.log(`Post alvo pronto para varredura (mediaId: ${targetMediaId}).`);
          if (Number.isFinite(targetCommentCount)) {
            console.log(
              `Comentários informados pela Meta: ${targetCommentCount}.`,
            );
          }
        }

        const stats = await runReplyScan({
          api,
          expectedCommentCount: targetCommentCount,
          mediaId: targetMediaId,
          replyText: config.replyText,
          signal: controller.signal,
        });
        if (controller.signal.aborted) break;
        printSummary(stats);
      } catch (error) {
        if (controller.signal.aborted || error?.name === "AbortError") break;

        console.error("\nA varredura foi interrompida:");
        console.error(formatInstagramApiError(error));

        if (error instanceof TargetPostNotFoundError) {
          console.error(
            "Verifique se TARGET_POST pertence à conta configurada e está acessível pela API.",
          );
          process.exitCode = 1;
          return;
        }

        if (error instanceof InstagramCommentsUnavailableError) {
          console.error(
            "A varredura foi encerrada para evitar milhares de requisições vazias.",
          );
          process.exitCode = 1;
          return;
        }

        if (
          isAuthenticationApiError(error) ||
          isPermissionApiError(error) ||
          (error instanceof InstagramApiError &&
            error.status >= 400 &&
            error.status < 500 &&
            !error.rateLimited)
        ) {
          console.error(
            "Erro global de autenticação, permissão ou configuração da API. Verifique o token, o usuário e as permissões do app.",
          );
          process.exitCode = 1;
          return;
        }

        if (Number.isFinite(error?.retryAfterMs)) {
          delayMs = Math.max(delayMs, error.retryAfterMs);
        }
      }

      const delaySeconds = Math.ceil(delayMs / 1_000);
      console.log(`\nPróxima varredura em ${delaySeconds} segundos.`);
      if (!(await wait(delayMs, controller.signal))) break;
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    controller.abort();
  }
}
