import { RATE_LIMIT_FALLBACK_MS } from "../config.js";
import {
  AuthenticationRequiredError,
  isLoggedIn,
  RateLimitError,
} from "./instagram.js";
import { LedgerWriteError } from "./reply-ledger.js";

const SELECTORS = Object.freeze({
  controls: 'button, [role="button"]',
  commentPermalinks: 'main a[href*="/c/"]',
  textboxes: [
    'textarea[aria-label*="comment" i]',
    'textarea[aria-label*="coment" i]',
    'textarea[aria-label*="reply" i]',
    'textarea[aria-label*="responder" i]',
    '[contenteditable="true"][aria-label*="comment" i]',
    '[contenteditable="true"][aria-label*="coment" i]',
    '[contenteditable="true"][aria-label*="reply" i]',
    '[contenteditable="true"][aria-label*="responder" i]',
  ].join(", "),
});

const REPLY_ACTION_PATTERN = /^(reply|responder)$/i;
const VIEW_REPLIES_PATTERN =
  /^(?:(?:view|see|load|show).*(?:repl|response)|(?:ver|carregar|mostrar).*(?:respost))/i;
const HIDE_REPLIES_PATTERN = /hide.*repl|ocultar.*respost/i;
const LOAD_COMMENTS_PATTERN =
  /(?:view|see|show) all comments|(?:load|view|see|show).*(?:more|previous|older).*(?:comment)|ver todos os coment[aá]rios|(?:carregar|ver|mostrar).*(?:mais|anteriores?).*(?:coment)/i;
const BLOCK_PATTERN =
  /try again later|tente novamente mais tarde|action blocked|ação bloqueada|we restrict certain activity|restringimos determinadas atividades|commenting has been limited|comentários foram limitados/i;
const MAX_STALLED_LOAD_ATTEMPTS = 3;

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
  return new DOMException("Operação cancelada.", "AbortError");
}

function normalizeUsername(value) {
  return String(value ?? "")
    .trim()
    .replace(/^@+/, "")
    .toLocaleLowerCase("en-US");
}

function truncateText(value, maximum = 160) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > maximum
    ? `${normalized.slice(0, maximum - 1)}…`
    : normalized;
}

function controlLabel(control) {
  return control
    .evaluate((element) =>
      [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.textContent,
      ]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .catch(() => "");
}

async function firstVisible(locators, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const locator of locators) {
      const count = Math.min(await locator.count().catch(() => 0), 30);
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        if (await candidate.isVisible().catch(() => false)) return candidate;
      }
    }
    await wait(200);
  }

  return null;
}

function commentPermalinks(page) {
  return page.locator(SELECTORS.commentPermalinks);
}

/**
 * Produz somente dados serializáveis. Nenhum ElementHandle é mantido entre
 * ações, pois o React do Instagram pode recriar a lista a qualquer momento.
 */
export async function findLoadedComments(page) {
  return commentPermalinks(page).evaluateAll((anchors) => {
    const reservedPaths = new Set([
      "accounts",
      "direct",
      "explore",
      "p",
      "reel",
      "reels",
      "stories",
    ]);

    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        box.width > 0 &&
        box.height > 0
      );
    };

    const profileFromLink = (link) => {
        const path = link.getAttribute("href") ?? "";
        let pathname = path;
        try {
          pathname = new URL(path, window.location.origin).pathname;
        } catch {
          // Mantém o valor original para que a heurística apenas o ignore.
        }
        const match = pathname.match(/^\/@?([^/?#]+)\/?$/);
        if (!match || reservedPaths.has(match[1].toLowerCase())) return "";
        return match[1];
    };

    const isReplyPermalink = (anchor) => {
      const list = anchor.closest("ul, ol");
      if (!list) return false;

      // No DOM observado, replies são inseridas em um <ul> dentro da thread.
      // Uma lista global de comentários não é confundida com replies: deve
      // existir, fora dessa lista e na mesma thread, o permalink do comentário pai.
      let scope = list.parentElement;
      while (scope && !scope.matches("main, article")) {
        const hasParentPermalink = [
          ...scope.querySelectorAll('a[href*="/c/"]'),
        ].some((candidate) => !list.contains(candidate));
        if (hasParentPermalink) return true;
        scope = scope.parentElement;
      }
      return false;
    };

    const readComment = (anchor) => {
      let metadata = anchor.parentElement;
      let authorLink;

      while (metadata && !metadata.matches("main, article")) {
        authorLink = [...metadata.querySelectorAll("a[href]")].find(
          (candidate) => profileFromLink(candidate),
        );
        if (authorLink) break;
        metadata = metadata.parentElement;
      }

      if (!metadata || !authorLink) return { author: "", text: "" };
      const author = profileFromLink(authorLink);
      const content = metadata.parentElement;
      const metadataText = (metadata.textContent ?? "").replace(/\s+/g, " ").trim();
      let text = (content?.textContent ?? "").replace(/\s+/g, " ").trim();
      if (metadataText && text.startsWith(metadataText)) {
        text = text.slice(metadataText.length).trim();
      }
      return { author, text };
    };

    const snapshots = [];
    const seen = new Set();

    anchors.forEach((anchor) => {
      if (!isVisible(anchor) || isReplyPermalink(anchor)) return;

      const permalink = anchor.getAttribute("href") ?? "";
      if (!permalink || seen.has(permalink)) return;
      const { author, text } = readComment(anchor);
      const time = anchor.querySelector("time");
      const timestamp =
        time?.getAttribute("datetime") || time?.textContent?.trim() || "";
      let key;
      try {
        const pathname = new URL(permalink, "https://www.instagram.com").pathname;
        const match = pathname.match(/\/c\/([^/]+)\/?$/);
        if (!match) return;
        key = `/c/${match[1]}/`;
      } catch {
        return;
      }

      if (seen.has(key)) return;
      seen.add(key);
      seen.add(permalink);
      snapshots.push({
        key,
        author,
        text,
        permalink,
        timestamp,
      });
    });

    return snapshots;
  });
}

export async function waitForCommentsArea(
  page,
  { signal, timeoutMs = 30_000 } = {},
) {
  await page.locator("main").waitFor({ state: "visible", timeout: timeoutMs });
  const deadline = Date.now() + timeoutMs;
  let loadControlAttempted = false;

  while (Date.now() < deadline && !signal?.aborted) {
    await detectInstagramBlock(page);
    const comments = await findLoadedComments(page);
    if (comments.length > 0) {
      const row = await locateComment(page, comments[0]);
      const hasScrollableAncestor = row
        ? await row
            .evaluate((element) => {
              let current = element.parentElement;
              while (current && current !== document.documentElement) {
                const style = getComputedStyle(current);
                if (
                  current.scrollHeight > current.clientHeight + 8 &&
                  /(auto|scroll|overlay)/.test(style.overflowY)
                ) {
                  return true;
                }
                current = current.parentElement;
              }
              return false;
            })
            .catch(() => false)
        : false;

      console.log(
        hasScrollableAncestor
          ? "Área de comentários localizada."
          : "Área de comentários localizada; painel sem scroll interno detectável.",
      );
      console.log(`Comentários inicialmente carregados: ${comments.length}.`);
      return comments.length;
    }

    if (!loadControlAttempted) {
      const loadControl = await findLoadCommentsControl(page);
      if (loadControl) {
        loadControlAttempted = true;
        console.log(
          `Abrindo comentários pelo controle: ${JSON.stringify(await controlLabel(loadControl))}`,
        );
        await loadControl.click();
      }
    }

    if (!(await wait(500, signal))) throw abortError();
  }

  if (signal?.aborted) throw abortError();

  const counts = await page.evaluate(() => {
    const labelOf = (element) =>
      [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.textContent,
      ]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    return {
      article: document.querySelectorAll("article").length,
      ul: document.querySelectorAll("ul").length,
      li: document.querySelectorAll("li").length,
      replyControls: [
        ...document.querySelectorAll('button, [role="button"]'),
      ].filter((element) => /^(reply|responder)$/i.test(labelOf(element))).length,
      commentPermalinks: document.querySelectorAll('a[href*="/c/"]').length,
    };
  });
  throw new Error(
    `A interface não disponibilizou comentários em ${Math.ceil(timeoutMs / 1_000)} segundos ` +
      `(article=${counts.article}, ul=${counts.ul}, li=${counts.li}, ` +
      `Reply=${counts.replyControls}, permalinks=${counts.commentPermalinks}).`,
  );
}

export function getCommentAuthor(comment) {
  return comment?.author ?? "";
}

export function getCommentText(comment) {
  return comment?.text ?? "";
}

async function locateComment(page, comment) {
  if (!comment.permalink) return null;
  const anchors = commentPermalinks(page);
  const index = await anchors
    .evaluateAll(
      (elements, permalink) =>
        elements.findIndex(
          (element) => element.getAttribute("href") === permalink,
        ),
      comment.permalink,
    )
    .catch(() => -1);
  if (index < 0) return null;

  let current = anchors.nth(index);
  for (let depth = 0; depth < 12; depth += 1) {
    const isCommentRow = await current
      .evaluate((element) => {
        const labelOf = (control) =>
          [
            control.getAttribute("aria-label"),
            control.getAttribute("title"),
            control.textContent,
          ]
            .filter(Boolean)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
        const ownPermalinkCount =
          (element.matches?.('a[href*="/c/"]') ? 1 : 0) +
          element.querySelectorAll('a[href*="/c/"]').length;
        const replyControlCount = [
          ...element.querySelectorAll('button, [role="button"]'),
        ].filter((control) => /^(reply|responder)$/i.test(labelOf(control))).length;
        return ownPermalinkCount === 1 && replyControlCount === 1;
      })
      .catch(() => false);
    if (isCommentRow) return current;

    const parent = current.locator("xpath=..");
    const tagName = await parent
      .evaluate((element) => element.tagName.toLowerCase())
      .catch(() => "");
    if (["main", "article", "body", "html"].includes(tagName)) break;
    current = parent;
  }

  return null;
}

async function ownReplyAuthors(page, comment) {
  const row = await locateComment(page, comment);
  if (!row || !(await row.isVisible().catch(() => false))) return null;
  const scope = await locateThreadScope(row);

  return scope.evaluate((thread, rootPermalink) => {
    const reservedPaths = new Set([
      "accounts",
      "direct",
      "explore",
      "p",
      "reel",
      "reels",
      "stories",
    ]);
    const profileFromLink = (link) => {
      const path = link.getAttribute("href") ?? "";
      let pathname = path;
      try {
        pathname = new URL(path, window.location.origin).pathname;
      } catch {
        // Mantém o valor original para que a heurística apenas o ignore.
      }
      const match = pathname.match(/^\/@?([^/?#]+)\/?$/);
      if (!match || reservedPaths.has(match[1].toLowerCase())) return "";
      return match[1];
    };

    const authors = [];
    for (const anchor of thread.querySelectorAll('a[href*="/c/"]')) {
      if (anchor.getAttribute("href") === rootPermalink) continue;
      if (!anchor.closest("ul, ol")) continue;

      let metadata = anchor.parentElement;
      let authorLink;
      while (metadata && metadata !== thread) {
        authorLink = [...metadata.querySelectorAll("a[href]")].find(
          (candidate) => profileFromLink(candidate),
        );
        if (authorLink) break;
        metadata = metadata.parentElement;
      }
      if (authorLink) authors.push(profileFromLink(authorLink));
    }

    return authors;
  }, comment.permalink);
}

export async function hasOwnBrowserReply(page, comment, ownUsername) {
  const authors = await ownReplyAuthors(page, comment);
  if (authors === null) {
    throw new Error("O comentário desapareceu enquanto as replies eram verificadas.");
  }

  const expected = normalizeUsername(ownUsername);
  return authors.some((author) => normalizeUsername(author) === expected);
}

async function locateThreadScope(row) {
  let scope = row;

  for (let depth = 0; depth < 12; depth += 1) {
    const parent = scope.locator("xpath=..");
    const metrics = await parent
      .evaluate((element) => {
        const labelOf = (control) =>
          [
            control.getAttribute("aria-label"),
            control.getAttribute("title"),
            control.textContent,
          ]
            .filter(Boolean)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
        const anchors = [...element.querySelectorAll('a[href*="/c/"]')];
        const rootPermalinks = anchors.filter((anchor) => !anchor.closest("ul, ol"));
        const controls = [...element.querySelectorAll('button, [role="button"]')];
        return {
          tagName: element.tagName.toLowerCase(),
          rootPermalinks: rootPermalinks.length,
          replyPermalinks: anchors.length - rootPermalinks.length,
          hasThreadControl: controls.some((control) =>
            /(?:view|see|load|show).*(?:repl|response)|(?:ver|carregar|mostrar).*(?:respost)|hide.*repl|ocultar.*respost/i.test(
              labelOf(control),
            ),
          ),
        };
      })
      .catch(() => null);

    if (
      !metrics ||
      ["main", "article", "body", "html"].includes(metrics.tagName) ||
      metrics.rootPermalinks > 1
    ) {
      break;
    }

    scope = parent;
    if (metrics.hasThreadControl || metrics.replyPermalinks > 0) return scope;
  }

  return scope;
}

async function findThreadExpansionControl(scope) {
  const controls = scope.locator(SELECTORS.controls);
  const count = Math.min(await controls.count().catch(() => 0), 100);

  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible().catch(() => false))) continue;
    const label = await controlLabel(control);
    if (VIEW_REPLIES_PATTERN.test(label) && !HIDE_REPLIES_PATTERN.test(label)) {
      return control;
    }
  }

  return null;
}

async function countVisibleReplies(page, comment) {
  const row = await locateComment(page, comment);
  if (!row) return 0;
  const scope = await locateThreadScope(row);
  return scope
    .locator('ul a[href*="/c/"], ol a[href*="/c/"]')
    .count()
    .catch(() => 0);
}

export async function expandCommentReplies(page, comment, { signal } = {}) {
  let stalledAttempts = 0;

  while (!signal?.aborted && stalledAttempts < MAX_STALLED_LOAD_ATTEMPTS) {
    const row = await locateComment(page, comment);
    if (!row || !(await row.isVisible().catch(() => false))) {
      throw new Error("O comentário desapareceu antes de expandir as replies.");
    }

    const scope = await locateThreadScope(row);
    const control = await findThreadExpansionControl(scope);
    if (!control) return;

    const before = await countVisibleReplies(page, comment);
    await control.click();
    if (!(await wait(350, signal))) throw abortError();

    const deadline = Date.now() + 4_000;
    let after = before;
    while (Date.now() < deadline && !signal?.aborted) {
      after = await countVisibleReplies(page, comment);
      if (after > before) break;
      await wait(200, signal);
    }

    stalledAttempts = after > before ? 0 : stalledAttempts + 1;
  }

  if (signal?.aborted) throw abortError();
}

function replyComposerLocators(page, row) {
  const composerName =
    /reply|responder|add a comment|adicionar coment[aá]rio|adicione um coment[aá]rio|comment|comentar/i;

  return [
    row.getByRole("textbox", { name: composerName }),
    row.locator(SELECTORS.textboxes),
    page.getByRole("textbox", { name: composerName }),
    page.getByPlaceholder(composerName),
    page.getByLabel(composerName),
    page.locator(SELECTORS.textboxes),
  ];
}

export async function openReplyComposer(page, comment) {
  const row = await locateComment(page, comment);
  if (!row || !(await row.isVisible().catch(() => false))) {
    throw new Error("O comentário desapareceu antes de abrir o composer.");
  }

  const controls = row.locator(SELECTORS.controls);
  const count = Math.min(await controls.count().catch(() => 0), 80);
  let replyControl;

  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible().catch(() => false))) continue;
    if (REPLY_ACTION_PATTERN.test(await controlLabel(control))) {
      replyControl = control;
      break;
    }
  }

  if (!replyControl) {
    throw new Error('Controle "Responder" não encontrado no comentário.');
  }

  await replyControl.click();
  const refreshedRow = await locateComment(page, comment);
  if (!refreshedRow) {
    throw new Error("O comentário desapareceu depois do clique em Responder.");
  }

  const composer = await firstVisible(
    replyComposerLocators(page, refreshedRow),
    5_000,
  );
  if (!composer) throw new Error("Campo para escrever a reply não encontrado.");
  return composer;
}

async function fillComposer(composer, text) {
  const type = await composer.evaluate((element) => ({
    tag: element.tagName.toLowerCase(),
    contentEditable: element.getAttribute("contenteditable") === "true",
  }));

  if (
    type.contentEditable ||
    type.tag === "input" ||
    type.tag === "textarea"
  ) {
    await composer.fill(text);
    return;
  }

  throw new Error("O campo de reply encontrado não aceita preenchimento.");
}

async function readComposer(composer) {
  return composer
    .evaluate((element) => {
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement
      ) {
        return element.value;
      }
      return element.textContent ?? "";
    })
    .catch(() => null);
}

async function detectInstagramBlock(page) {
  if (/\/(challenge|checkpoint)(?:\/|$)/i.test(page.url())) {
    throw new AuthenticationRequiredError();
  }

  const notices = await page
    .locator('[role="alert"], [role="dialog"]')
    .allInnerTexts()
    .catch(() => []);
  const visibleBlockingText = await page
    .getByText(BLOCK_PATTERN)
    .first()
    .isVisible()
    .catch(() => false);
  if (
    visibleBlockingText ||
    notices.some((notice) => BLOCK_PATTERN.test(notice))
  ) {
    throw new RateLimitError(RATE_LIMIT_FALLBACK_MS, false);
  }

  if (!(await isLoggedIn(page))) throw new AuthenticationRequiredError();
}

async function waitForSubmission(page, composer, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await detectInstagramBlock(page);
    const value = await readComposer(composer);
    if (value !== null && value.trim() === "") return;
    if (value === null) {
      if (page.isClosed()) throw new Error("O navegador fechou antes da confirmação da reply.");
      if (!(await composer.isVisible().catch(() => false))) return;
    }
    await wait(250);
  }

  throw new Error("Não foi possível confirmar o envio da reply.");
}

export async function submitReply(page, composer, replyText, { timeoutMs = 10_000 } = {}) {
  await fillComposer(composer, replyText);

  const submitName =
    /^(Post|Reply|Send|Publicar|Responder|Enviar)$/i;
  const form = composer.locator(
    'xpath=ancestor::*[self::form or @role="form"][1]',
  );
  const nearby = composer.locator(
    'xpath=ancestor::*[.//button or .//*[@role="button"]][1]',
  );
  const submit = await firstVisible(
    [
      form.getByRole("button", { name: submitName }),
      nearby.getByRole("button", { name: submitName }),
      page.getByRole("button", { name: submitName }),
    ],
    3_000,
  );

  if (submit) {
    await submit.click();
  } else {
    await composer.focus();
    await composer.press("Enter");
  }

  await waitForSubmission(page, composer, timeoutMs);
  await detectInstagramBlock(page);
}

async function findLoadCommentsControl(page) {
  const controls = page.locator(SELECTORS.controls);
  const count = Math.min(await controls.count().catch(() => 0), 300);

  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible().catch(() => false))) continue;
    if (LOAD_COMMENTS_PATTERN.test(await controlLabel(control))) return control;
  }

  return null;
}

async function scrollCommentsContainer(page) {
  const loaded = await findLoadedComments(page);
  if (loaded.length === 0) {
    return page.evaluate(() => {
      const scrolling = document.scrollingElement;
      if (!scrolling) return false;
      const before = scrolling.scrollTop;
      scrolling.scrollBy(0, Math.max(window.innerHeight * 0.8, 500));
      return scrolling.scrollTop !== before;
    });
  }

  const item = await locateComment(page, loaded.at(-1));
  if (!item) return false;

  return item.evaluate((element) => {
    let current = element.parentElement;
    while (current && current !== document.documentElement) {
      const style = window.getComputedStyle(current);
      const canScroll = current.scrollHeight > current.clientHeight + 8;
      const allowsScroll = /(auto|scroll|overlay)/.test(style.overflowY);
      if (canScroll && allowsScroll) {
        const before = current.scrollTop;
        current.scrollBy(0, Math.max(current.clientHeight * 0.8, 400));
        current.dispatchEvent(new Event("scroll", { bubbles: true }));
        return current.scrollTop !== before;
      }
      current = current.parentElement;
    }

    const scrolling = document.scrollingElement;
    if (!scrolling) return false;
    const before = scrolling.scrollTop;
    scrolling.scrollBy(0, Math.max(window.innerHeight * 0.8, 500));
    return scrolling.scrollTop !== before;
  });
}

export async function loadMoreComments(
  page,
  knownCommentKeys,
  { signal } = {},
) {
  if (signal?.aborted) throw abortError();

  const loadControl = await findLoadCommentsControl(page);
  if (loadControl) {
    await loadControl.click().catch(() => {});
  } else {
    const scrolled = await scrollCommentsContainer(page);
    if (!scrolled) return 0;
  }

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !signal?.aborted) {
    await detectInstagramBlock(page);
    const loaded = await findLoadedComments(page);
    const newCount = loaded.filter(
      (comment) => !knownCommentKeys.has(comment.key),
    ).length;
    if (newCount > 0) return newCount;
    await wait(150, signal);
  }

  if (signal?.aborted) throw abortError();
  return 0;
}

function parseRetryAfter(response) {
  const value = response.headers()["retry-after"]?.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(date - Date.now(), 0);
}

function createCapturedRateLimit(response) {
  const retryAfterMs = parseRetryAfter(response);
  return new RateLimitError(
    retryAfterMs || RATE_LIMIT_FALLBACK_MS,
    retryAfterMs !== null,
  );
}

function isGlobalBrowserError(error) {
  return (
    error?.name === "AbortError" ||
    error instanceof AuthenticationRequiredError ||
    error instanceof RateLimitError ||
    error instanceof LedgerWriteError
  );
}

export async function scanAndReplyToComments(
  page,
  { ownUsername, replyText, intervalMs, maxPerScan = 0, ledger, signal, submissionTimeoutMs },
) {
  const stats = {
    commentsAnalyzed: 0,
    alreadyProcessed: 0,
    repliesSent: 0,
    ownComments: 0,
    errors: 0,
  };
  const currentScanProcessed = new Set();
  let stalledLoadAttempts = 0;
  let capturedRateLimit;
  let lastAuthor = "";
  let lastReplyAt = 0;
  const authorsRepliedThisBatch = new Set();

  const captureRateLimit = (response) => {
    if (response.status() === 429 && response.url().includes("instagram.com")) {
      capturedRateLimit ??= response;
    }
  };
  const throwIfRateLimited = () => {
    if (capturedRateLimit) throw createCapturedRateLimit(capturedRateLimit);
  };

  page.on("response", captureRateLimit);

  try {
    while (
      !signal?.aborted &&
      stalledLoadAttempts < MAX_STALLED_LOAD_ATTEMPTS
    ) {
      throwIfRateLimited();
      await detectInstagramBlock(page);

      const loaded = await findLoadedComments(page);
      const pending = loaded.filter(
        (comment) => !currentScanProcessed.has(comment.key),
      );
      authorsRepliedThisBatch.clear();

      while (pending.length > 0) {
        if (signal?.aborted) break;
        if (maxPerScan > 0 && stats.repliesSent >= maxPerScan) break;

        // Reordena somente a fila já visível, sem buscas adicionais no DOM.
        let alternate = pending.findIndex((candidate) => {
          const author = normalizeUsername(candidate.author);
          return author !== lastAuthor && !authorsRepliedThisBatch.has(author);
        });
        if (alternate < 0) {
          alternate = pending.findIndex(
            (candidate) => normalizeUsername(candidate.author) !== lastAuthor,
          );
        }
        const [comment] = pending.splice(alternate > 0 ? alternate : 0, 1);
        currentScanProcessed.add(comment.key);
        stats.commentsAnalyzed += 1;

        const author = getCommentAuthor(comment);
        const normalizedAuthor = normalizeUsername(author);
        console.log(`\n${author ? `@${author}` : "@usuário-desconhecido"}`);
        console.log(
          `comentário: ${JSON.stringify(truncateText(getCommentText(comment)))}`,
        );

        if (ledger.has(comment.key)) {
          stats.alreadyProcessed += 1;
          console.log("status: já processado → ignorado");
          continue;
        }

        if (normalizedAuthor === normalizeUsername(ownUsername)) {
          stats.ownComments += 1;
          console.log("status: comentário próprio → ignorado");
          continue;
        }

        if (!normalizedAuthor) {
          stats.errors += 1;
          console.error("erro ao processar comentário: autor não identificado.");
          continue;
        }

        try {
          if (lastReplyAt && intervalMs > 0) {
            const remaining = intervalMs - (Date.now() - lastReplyAt);
            if (remaining > 0 && !(await wait(remaining, signal))) throw abortError();
          }
          throwIfRateLimited();
          await detectInstagramBlock(page);
          console.log("status: respondendo...");
          const composer = await openReplyComposer(page, comment);
          await submitReply(page, composer, replyText, {
            timeoutMs: submissionTimeoutMs,
          });
          throwIfRateLimited();
          await ledger.markProcessed(comment.key, author);
          stats.repliesSent += 1;
          lastReplyAt = Date.now();
          lastAuthor = normalizedAuthor;
          authorsRepliedThisBatch.add(normalizedAuthor);
          console.log("reply enviada");
          console.log("ledger atualizado");
        } catch (error) {
          if (isGlobalBrowserError(error)) throw error;
          stats.errors += 1;
          console.error(
            `erro ao processar comentário: ${error instanceof Error ? error.message : error}`,
          );
        }
      }

      if (signal?.aborted) break;
      if (maxPerScan > 0 && stats.repliesSent >= maxPerScan) break;

      console.log("\nCarregando mais comentários...");
      const newCount = await loadMoreComments(page, currentScanProcessed, { signal });
      throwIfRateLimited();

      if (newCount > 0) {
        console.log(`${newCount} novos comentários encontrados.`);
        stalledLoadAttempts = 0;
      } else {
        stalledLoadAttempts += 1;
        console.log(
          `Nenhum comentário novo carregado (tentativa ${stalledLoadAttempts}/${MAX_STALLED_LOAD_ATTEMPTS}).`,
        );
      }
    }

    if (signal?.aborted) throw abortError();
    return stats;
  } finally {
    page.off("response", captureRateLimit);
  }
}
