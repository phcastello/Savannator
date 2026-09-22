const GRAPH_API_HOST = "graph.instagram.com";
const REQUEST_TIMEOUT_MS = 30_000;
const GET_ATTEMPTS = 3;
const RATE_LIMIT_RETRY_MS = 60_000;
const TRANSIENT_ERROR_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);

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

function abortError() {
  const error = new Error("Operação cancelada.");
  error.name = "AbortError";
  return error;
}

function parseRetryAfter(headers) {
  const value = headers.get("retry-after")?.trim();
  if (!value) return null;

  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000;
    return Number.isFinite(delay) && delay > 0 ? delay : null;
  }

  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;

  const delay = date - Date.now();
  return delay > 0 ? delay : null;
}

function sanitize(value, accessToken) {
  const text = String(value ?? "Erro desconhecido.");
  return accessToken ? text.replaceAll(accessToken, "[REDACTED]") : text;
}

function normalizeUsername(username) {
  return String(username ?? "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
}

function normalizePermalink(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${hostname}${pathname}`;
  } catch {
    return null;
  }
}

function actorIds(comment) {
  return [
    comment?.user?.id,
    comment?.user,
    comment?.from?.id,
  ]
    .filter((value) => value !== undefined && value !== null)
    .map(String);
}

function actorUsernames(comment) {
  return [comment?.from?.username, comment?.username]
    .map(normalizeUsername)
    .filter(Boolean);
}

export class InstagramApiError extends Error {
  constructor({
    operation,
    method,
    status,
    metaError,
    message,
    context = {},
    retryAfterMs,
    retryable = false,
    rateLimited = false,
  }) {
    const metaMessage = metaError?.message ?? message ?? "Erro desconhecido da API.";
    super(`${operation}: ${metaMessage}`);
    this.name = "InstagramApiError";
    this.operation = operation;
    this.method = method;
    this.status = status;
    this.metaMessage = metaMessage;
    this.metaCode = metaError?.code;
    this.metaSubcode = metaError?.error_subcode;
    this.context = context;
    this.retryAfterMs = retryAfterMs;
    this.retryable = retryable;
    this.rateLimited = rateLimited;
  }
}

export class InstagramCommentsUnavailableError extends Error {
  constructor({ mediaId, expectedCount, emptyBatches }) {
    super(
      [
        `A Meta informa ${expectedCount} comentários no TARGET_POST,`,
        `mas a API retornou ${emptyBatches} lotes vazios consecutivos.`,
        "Isso indica que os comentários existem, porém não estão acessíveis ao token/app atual.",
        "Verifique instagram_business_manage_comments, o Access Level da permissão,",
        "se a conta está adicionada ao app e se o app está no modo adequado.",
      ].join(" "),
    );
    this.name = "InstagramCommentsUnavailableError";
    this.mediaId = mediaId;
    this.expectedCount = expectedCount;
    this.emptyBatches = emptyBatches;
  }
}

export function isAuthenticationApiError(error) {
  return (
    error instanceof InstagramApiError &&
    (error.status === 401 || [102, 190].includes(error.metaCode))
  );
}

export function isPermissionApiError(error) {
  return (
    error instanceof InstagramApiError &&
    (error.status === 403 || [10, 200, 299].includes(error.metaCode))
  );
}

export function formatInstagramApiError(error) {
  if (!(error instanceof InstagramApiError)) {
    return error instanceof Error ? error.message : String(error);
  }

  const lines = [
    `Operação: ${error.operation}`,
    `Status HTTP: ${error.status ?? "sem resposta HTTP"}`,
    `Mensagem da Meta: ${error.metaMessage}`,
  ];

  if (error.metaCode !== undefined) {
    lines.push(`Código da Meta: ${error.metaCode}`);
  }
  if (error.context.mediaId) {
    lines.push(`mediaId: ${error.context.mediaId}`);
  }
  if (error.context.commentId) {
    lines.push(`commentId: ${error.context.commentId}`);
  }

  return lines.join("\n");
}

export function createInstagramApiClient({
  accessToken,
  userId,
  username,
  graphApiVersion,
  fetchImpl = globalThis.fetch,
  logger = console,
}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Este ambiente não fornece um cliente HTTP compatível com fetch.");
  }

  const baseUrl = `https://${GRAPH_API_HOST}/${graphApiVersion}/`;
  const ownUsername = normalizeUsername(username);

  function buildUrl(pathOrUrl, parameters = {}) {
    const url = new URL(pathOrUrl, baseUrl);

    if (url.protocol !== "https:" || url.hostname !== GRAPH_API_HOST) {
      throw new Error("A paginação retornou uma URL fora de graph.instagram.com.");
    }

    // A autenticação é sempre enviada no header. Isso também remove tokens que
    // a Meta possa incluir nas URLs de paginação antes de segui-las.
    url.searchParams.delete("access_token");
    for (const [key, value] of Object.entries(parameters)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    return url;
  }

  async function makeRequest({
    method,
    pathOrUrl,
    parameters,
    body,
    operation,
    context,
    signal,
  }) {
    const maximumAttempts = method === "GET" ? GET_ATTEMPTS : 1;

    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      if (signal?.aborted) throw abortError();

      const url = buildUrl(pathOrUrl, parameters);
      const timeoutController = new AbortController();
      const timeout = setTimeout(
        () => timeoutController.abort(),
        REQUEST_TIMEOUT_MS,
      );
      let response;
      let payload;

      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: timeoutController.signal,
        });

        const responseText = await response.text();
        if (responseText) {
          try {
            payload = JSON.parse(responseText);
          } catch {
            payload = undefined;
          }
        }
      } catch (cause) {
        const message = timeoutController.signal.aborted
          ? "Tempo limite da requisição excedido."
          : sanitize(cause instanceof Error ? cause.message : cause, accessToken);
        const error = new InstagramApiError({
          operation,
          method,
          message,
          context,
          retryable: true,
        });

        if (attempt === maximumAttempts) throw error;

        const delayMs = 2 ** (attempt - 1) * 2_000;
        logger.warn(
          `Falha transitória ao ${operation}; nova tentativa em ${Math.ceil(delayMs / 1_000)} segundos.`,
        );
        if (!(await wait(delayMs, signal))) throw abortError();
        continue;
      } finally {
        clearTimeout(timeout);
      }

      if (response.ok) return payload ?? {};

      const metaError = payload?.error;
      if (metaError?.message) {
        metaError.message = sanitize(metaError.message, accessToken);
      }
      const rateLimited =
        response.status === 429 ||
        [4, 17, 32, 341, 613].includes(metaError?.code);
      const retryable =
        rateLimited ||
        response.status >= 500 ||
        metaError?.is_transient === true ||
        TRANSIENT_ERROR_CODES.has(metaError?.code);
      const retryAfterMs =
        parseRetryAfter(response.headers) ??
        (rateLimited ? RATE_LIMIT_RETRY_MS : undefined);
      const error = new InstagramApiError({
        operation,
        method,
        status: response.status,
        metaError,
        message: response.statusText,
        context,
        retryAfterMs,
        retryable,
        rateLimited,
      });

      if (!retryable || attempt === maximumAttempts) throw error;

      const delayMs = retryAfterMs ?? 2 ** (attempt - 1) * 2_000;
      logger.warn(
        `Falha transitória ao ${operation}; nova tentativa em ${Math.ceil(delayMs / 1_000)} segundos.`,
      );
      if (!(await wait(delayMs, signal))) throw abortError();
    }

    throw new Error(`Falha inesperada ao ${operation}.`);
  }

  async function instagramGet(pathOrUrl, options = {}) {
    return makeRequest({
      method: "GET",
      pathOrUrl,
      ...options,
    });
  }

  async function instagramPost(pathOrUrl, options = {}) {
    return makeRequest({
      method: "POST",
      pathOrUrl,
      ...options,
    });
  }

  async function getAllPages(
    pathOrUrl,
    {
      parameters,
      find,
      onPageStart,
      onPage,
      ...options
    } = {},
  ) {
    const items = [];
    const visitedPages = new Set();
    let nextUrl = pathOrUrl;
    let nextParameters = parameters;
    let pageNumber = 1;

    while (nextUrl) {
      onPageStart?.({ pageNumber });

      const pageUrl = buildUrl(nextUrl, nextParameters);
      const pageKey = pageUrl.toString();
      if (visitedPages.has(pageKey)) {
        throw new InstagramApiError({
          operation: options.operation,
          method: "GET",
          message: "A API repetiu a mesma página durante a paginação.",
          context: options.context,
        });
      }
      visitedPages.add(pageKey);

      const payload = await instagramGet(pageUrl, options);
      if (!Array.isArray(payload.data)) {
        throw new InstagramApiError({
          operation: options.operation,
          method: "GET",
          message: "A resposta da API não contém uma lista em data.",
          context: options.context,
        });
      }

      items.push(...payload.data);
      const match = find ? payload.data.find(find) : undefined;
      onPage?.({
        pageNumber,
        itemCount: payload.data.length,
        totalItems: items.length,
        match,
        hasNext: Boolean(payload.paging?.next),
      });
      if (match) return match;

      nextUrl = payload.paging?.next ?? null;
      nextParameters = undefined;
      pageNumber += 1;
    }

    return find ? null : items;
  }

  function isOwnComment(comment) {
    if (actorIds(comment).includes(String(userId))) return true;
    return Boolean(
      ownUsername && actorUsernames(comment).includes(ownUsername),
    );
  }

  async function getAllMedia({ signal } = {}) {
    return getAllPages(`${encodeURIComponent(userId)}/media`, {
      parameters: { fields: "id,permalink" },
      operation: "buscar mídias",
      context: {},
      signal,
    });
  }

  async function getTargetMedia(targetPost, { signal } = {}) {
    const normalizedTarget = normalizePermalink(targetPost);

    logger.log("Localizando TARGET_POST nas mídias da conta...");
    return getAllPages(`${encodeURIComponent(userId)}/media`, {
      parameters: { fields: "id,permalink,comments_count" },
      find: (item) => normalizePermalink(item?.permalink) === normalizedTarget,
      onPageStart: ({ pageNumber }) => {
        logger.log(
          pageNumber === 1
            ? "Procurando o post configurado..."
            : "Continuando a procura pelo post configurado...",
        );
      },
      onPage: ({ totalItems, match }) => {
        logger.log(`Publicações verificadas: ${totalItems}.`);
        if (match) logger.log("TARGET_POST localizado.");
      },
      operation: "buscar mídias",
      context: {},
      signal,
    });
  }

  async function getAllComments(
    mediaId,
    { expectedCount, signal } = {},
  ) {
    let consecutiveEmptyBatches = 0;

    return getAllPages(`${encodeURIComponent(mediaId)}/comments`, {
      parameters: {
        fields: "id,text,timestamp,from,user,username,parent_id",
      },
      operation: "buscar comentários",
      context: { mediaId },
      signal,
      onPageStart: ({ pageNumber }) => {
        logger.log(
          pageNumber === 1
            ? "Carregando comentários do post..."
            : "Continuando o carregamento dos comentários...",
        );
      },
      onPage: ({ itemCount, totalItems, hasNext }) => {
        if (itemCount > 0) {
          consecutiveEmptyBatches = 0;
          logger.log(`Comentários carregados até agora: ${totalItems}.`);
          return;
        }

        consecutiveEmptyBatches += 1;
        logger.warn(
          `A API retornou um lote vazio de comentários (${consecutiveEmptyBatches} consecutivo${consecutiveEmptyBatches === 1 ? "" : "s"}).`,
        );

        const hasKnownComments =
          Number.isFinite(expectedCount) && expectedCount > 0;
        if (
          hasKnownComments &&
          totalItems === 0 &&
          (!hasNext || consecutiveEmptyBatches >= 3)
        ) {
          throw new InstagramCommentsUnavailableError({
            mediaId,
            expectedCount,
            emptyBatches: consecutiveEmptyBatches,
          });
        }
      },
    });
  }

  async function getAllReplies(commentId, { mediaId, signal } = {}) {
    return getAllPages(`${encodeURIComponent(commentId)}/replies`, {
      parameters: {
        fields: "id,text,timestamp,from,user,username,parent_id",
      },
      operation: "buscar replies",
      context: { mediaId, commentId },
      signal,
      onPageStart: ({ pageNumber }) => {
        if (pageNumber > 1) {
          logger.log("Continuando a leitura das replies...");
        }
      },
      onPage: ({ pageNumber, totalItems }) => {
        if (pageNumber > 1) {
          logger.log(`Replies carregadas até agora: ${totalItems}.`);
        }
      },
    });
  }

  async function hasOwnReply(commentId, options = {}) {
    const replies = await getAllReplies(commentId, options);
    return replies.some(isOwnComment);
  }

  async function replyToComment(commentId, message, { mediaId, signal } = {}) {
    if (signal?.aborted) throw abortError();

    return instagramPost(`${encodeURIComponent(commentId)}/replies`, {
      body: { message },
      operation: "enviar reply",
      context: { mediaId, commentId },
      signal,
    });
  }

  return {
    getAllMedia,
    getTargetMedia,
    getAllComments,
    getAllReplies,
    hasOwnReply,
    isOwnComment,
    replyToComment,
  };
}
