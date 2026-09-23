import {
  COMMENT_TEXTS,
  GIF_SEARCH_TERMS,
  RATE_LIMIT_FALLBACK_MS,
  TARGET_POST,
} from "../config.js";

const INSTAGRAM_HOME = "https://www.instagram.com/";
const LOGIN_POLL_INTERVAL_MS = 2_000;

// Todos os seletores específicos do Instagram ficam neste módulo.
const SELECTORS = Object.freeze({
  loginUsername: 'input[name="username"]',
  gifResults: [
    'button:has(img[src]), [role="button"]:has(img[src])',
    'button:has([role="img"]), [role="button"]:has([role="img"])',
  ].join(", "),
});

const NON_RESULT_CONTROL_PATTERN =
  /close|back|search|clear|cancel|fechar|voltar|pesquis|limpar|cancelar/i;

export class AuthenticationRequiredError extends Error {
  constructor() {
    super("A sessão do Instagram não está autenticada.");
    this.name = "AuthenticationRequiredError";
  }
}

export class RateLimitError extends Error {
  constructor(retryAfterMs, hasRetryAfter = false) {
    super("Instagram respondeu com HTTP 429 (Too Many Requests).");
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
    this.hasRetryAfter = hasRetryAfter;
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

function isLoginOrChallengeUrl(url) {
  return ["/accounts/login", "/challenge", "/checkpoint"].some((part) =>
    url.includes(part),
  );
}

async function hasVisibleLoginForm(page) {
  return page.locator(SELECTORS.loginUsername).isVisible().catch(() => false);
}

export async function isLoggedIn(page) {
  if (page.isClosed() || isLoginOrChallengeUrl(page.url())) return false;
  if (await hasVisibleLoginForm(page)) return false;

  const cookies = await page
    .context()
    .cookies(INSTAGRAM_HOME)
    .catch(() => []);
  const now = Date.now() / 1_000;

  return cookies.some(
    (cookie) =>
      cookie.name === "sessionid" &&
      cookie.value &&
      (cookie.expires === -1 || cookie.expires > now),
  );
}

export async function openInstagramHome(page) {
  await page.goto(INSTAGRAM_HOME, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
}

export function isOnTargetPost(page) {
  try {
    const current = new URL(page.url());
    const target = new URL(TARGET_POST);
    return (
      current.hostname === target.hostname &&
      current.pathname === target.pathname
    );
  } catch {
    return false;
  }
}

export async function ensureLoggedIn(
  page,
  { signal, announceExisting = false } = {},
) {
  if (await isLoggedIn(page)) {
    if (announceExisting) {
      console.log("Sessão encontrada.");
      console.log("Conta autenticada.");
    }
    return true;
  }

  console.log("Nenhuma sessão autenticada encontrada.");
  console.log("Faça login no Instagram pelo navegador aberto.");
  console.log("Aguardando login...");

  while (!signal?.aborted && !page.isClosed()) {
    if (await isLoggedIn(page)) {
      console.log("Login detectado.");
      console.log("Continuando...");
      return true;
    }

    if (!(await wait(LOGIN_POLL_INTERVAL_MS, signal))) return false;
  }

  return false;
}

function parseRetryAfter(response) {
  const value = response.headers()["retry-after"]?.trim();
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

function createRateLimitError(response) {
  const retryAfterMs = parseRetryAfter(response);
  return new RateLimitError(
    retryAfterMs ?? RATE_LIMIT_FALLBACK_MS,
    retryAfterMs !== null,
  );
}

export async function openTargetPost(page) {
  console.log("\nAbrindo post alvo...");
  let rateLimitResponse;

  const captureRateLimit = (response) => {
    const request = response.request();
    if (
      response.status() === 429 &&
      request.isNavigationRequest() &&
      request.frame() === page.mainFrame()
    ) {
      rateLimitResponse = response;
    }
  };

  page.on("response", captureRateLimit);

  try {
    const response = await page.goto(TARGET_POST, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    if (response?.status() === 429) {
      throw createRateLimitError(response);
    }
  } catch (error) {
    if (error instanceof RateLimitError) throw error;
    if (rateLimitResponse) throw createRateLimitError(rateLimitResponse);
    throw error;
  } finally {
    page.off("response", captureRateLimit);
  }

  if (!(await isLoggedIn(page))) {
    throw new AuthenticationRequiredError();
  }

  console.log("Post carregado.");
}

async function firstVisible(locators, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const locator of locators) {
      const count = Math.min(await locator.count().catch(() => 0), 20);

      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        if (await candidate.isVisible().catch(() => false)) return candidate;
      }
    }
    await wait(250);
  }

  return null;
}

function gifButtonLocators(page) {
  return [
    page.getByRole("button", { name: /^GIF$/i }),
    page.getByRole("button", {
      name: /^(Choose|Select|Escolher|Selecionar).+GIF$/i,
    }),
    page.locator(
      [
        'button[aria-label*="GIF" i]',
        '[role="button"][aria-label*="GIF" i]',
        'button[title*="GIF" i]',
        '[role="button"][title*="GIF" i]',
        'button:has(svg[aria-label*="GIF" i])',
        '[role="button"]:has(svg[aria-label*="GIF" i])',
        'button:has([title*="GIF" i])',
        '[role="button"]:has([title*="GIF" i])',
      ].join(", "),
    ),
    page
      .locator("svg:has(title)")
      .filter({ hasText: /GIF/i })
      .locator('xpath=ancestor::*[self::button or @role="button"][1]'),
    page
      .getByText(/^GIF$/i)
      .locator('xpath=ancestor-or-self::*[self::button or @role="button"][1]'),
    page.getByLabel(/^(GIF|Choose a GIF|Select a GIF|Escolher GIF|Selecionar GIF)$/i),
  ];
}

function commentComposerLocators(page) {
  const commentName =
    /add a comment|adicionar coment[aá]rio|adicione um coment[aá]rio|comment|comentar/i;
  const composerSelector = [
    'textarea[aria-label*="comment" i]',
    'textarea[aria-label*="coment" i]',
    '[contenteditable="true"][aria-label*="comment" i]',
    '[contenteditable="true"][aria-label*="coment" i]',
  ].join(", ");

  return [
    page.locator("main article").locator(composerSelector),
    page.locator("main").locator(composerSelector),
    page.locator(composerSelector),
    page.getByRole("textbox", { name: commentName }),
    page.getByPlaceholder(commentName),
    page.getByLabel(commentName),
  ];
}

async function revealCommentComposer(page) {
  let composer = await firstVisible(commentComposerLocators(page), 1_500);
  if (composer) {
    await composer.click();
    return;
  }

  const commentButton = await firstVisible(
    [
      page.getByRole("button", { name: /^(Comment|Comentar)$/i }),
      page.getByLabel(/^(Comment|Comentar)$/i),
    ],
    2_000,
  );

  await commentButton?.click();

  composer = await firstVisible(commentComposerLocators(page), 3_000);
  await composer?.click();
}

async function findCommentComposer(page) {
  let composer = await firstVisible(commentComposerLocators(page), 3_000);
  if (composer) return composer;

  await revealCommentComposer(page);
  composer = await firstVisible(commentComposerLocators(page), 4_000);
  return composer;
}

async function findGifPicker(page, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const dialogs = page.getByRole("dialog");
    const count = await dialogs.count();

    for (let index = count - 1; index >= 0; index -= 1) {
      const dialog = dialogs.nth(index);
      if (!await dialog.isVisible().catch(() => false)) continue;

      const textbox = dialog.getByRole("textbox").first();
      if (await textbox.isVisible().catch(() => false)) {
        return { picker: dialog, textbox };
      }
    }

    await wait(250);
  }

  return null;
}

function gifResultRegionLocators(picker) {
  return [
    picker.getByRole("grid"),
    picker.getByRole("listbox"),
    picker.locator(
      [
        '[role="region"][aria-label*="GIF" i]',
        '[role="region"][aria-label*="result" i]',
        '[role="region"][aria-label*="resultado" i]',
        '[role="list"][aria-label*="GIF" i]',
        '[role="list"][aria-label*="result" i]',
        '[role="list"][aria-label*="resultado" i]',
        '[data-testid*="gif" i][data-testid*="result" i]',
      ].join(", "),
    ),
  ];
}

function explicitGifResultLocators(picker) {
  return picker.locator(
    [
      'button:has(img[alt*="GIF" i])',
      '[role="button"]:has(img[alt*="GIF" i])',
      'button:has(img[src*="giphy" i])',
      '[role="button"]:has(img[src*="giphy" i])',
      'button:has(img[src*="tenor" i])',
      '[role="button"]:has(img[src*="tenor" i])',
      'button[data-testid*="gif" i]:has(img)',
      '[role="button"][data-testid*="gif" i]:has(img)',
    ].join(", "),
  );
}

async function isResultControl(locator) {
  const description = await locator
    .evaluate((element) =>
      [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.textContent,
      ]
        .filter(Boolean)
        .join(" ")
        .slice(0, 160),
    )
    .catch(() => "");

  return NON_RESULT_CONTROL_PATTERN.test(description);
}

async function visibleClickableResults(candidates, maximum) {
  const results = [];
  const count = Math.min(await candidates.count(), 40);

  for (let index = 0; index < count && results.length < maximum; index += 1) {
    const candidate = candidates.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    if (await isResultControl(candidate)) continue;
    results.push(candidate);
  }

  return results;
}

async function visibleResults(picker, maximum = 12) {
  for (const regions of gifResultRegionLocators(picker)) {
    const regionCount = Math.min(await regions.count(), 10);

    for (let index = 0; index < regionCount; index += 1) {
      const region = regions.nth(index);
      if (!await region.isVisible().catch(() => false)) continue;

      const results = await visibleClickableResults(
        region.locator(SELECTORS.gifResults),
        maximum,
      );
      if (results.length > 0) return results;
    }
  }

  return visibleClickableResults(explicitGifResultLocators(picker), maximum);
}

async function waitForGifResults(picker, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const results = await visibleResults(picker);
    if (results.length > 0) return results;
    await wait(300);
  }

  return [];
}

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

async function printVisibleCandidates(scope, heading, { commentsOnly = false } = {}) {
  const candidates = await scope
    .locator(
      [
        "button",
        '[role="button"]',
        '[role="grid"]',
        '[role="listbox"]',
        '[role="option"]',
        '[role="gridcell"]',
        "textarea",
        "input",
        '[contenteditable="true"]',
        "svg[aria-label]",
        "svg:has(title)",
        "img[alt]",
        "[aria-label]",
        "[title]",
      ].join(", "),
    )
    .evaluateAll((elements, onlyComments) => {
      const relevant = /gif|comment|comentar|comentário|emoji/i;
      const seen = new Set();
      const output = [];

      for (const element of elements) {
        const style = window.getComputedStyle(element);
        const box = element.getBoundingClientRect();
        if (style.display === "none" || style.visibility === "hidden") continue;
        if (box.width === 0 || box.height === 0) continue;

        const item = {
          tag: element.tagName,
          role: element.getAttribute("role"),
          ariaLabel: element.getAttribute("aria-label"),
          title: element.getAttribute("title"),
          placeholder: element.getAttribute("placeholder"),
          contentEditable: element.getAttribute("contenteditable"),
          text: (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
        };
        const searchable = Object.values(item).filter(Boolean).join(" ");
        if (onlyComments && !relevant.test(searchable)) continue;

        const key = JSON.stringify(item);
        if (seen.has(key)) continue;
        seen.add(key);
        output.push(item);
        if (output.length === 12) break;
      }

      return output;
    }, commentsOnly)
    .catch(() => []);

  console.warn(`\n${heading}`);
  if (candidates.length === 0) {
    console.warn("Nenhum candidato visível relevante foi encontrado.");
    return;
  }

  for (const [index, candidate] of candidates.entries()) {
    console.warn(`\n${index + 1}.`);
    console.warn(`tag: ${candidate.tag}`);
    console.warn(`role: ${candidate.role ?? "null"}`);
    console.warn(`aria-label: ${candidate.ariaLabel ?? "null"}`);
    console.warn(`title: ${candidate.title ?? "null"}`);
    console.warn(`placeholder: ${candidate.placeholder ?? "null"}`);
    console.warn(`contenteditable: ${candidate.contentEditable ?? "null"}`);
    console.warn(`text: ${candidate.text || "null"}`);
  }
}

async function waitForPickerToClose(picker, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!await picker.isVisible().catch(() => false)) return;
    await wait(250);
  }

  throw new Error(
    "O seletor de GIF permaneceu aberto; não foi possível confirmar que a ação avançou.",
  );
}

export async function performGifAction(page, { debug = false } = {}) {
  if (!(await isLoggedIn(page))) throw new AuthenticationRequiredError();
  if (GIF_SEARCH_TERMS.length === 0) {
    throw new Error("GIF_SEARCH_TERMS precisa ter pelo menos um termo.");
  }

  let gifButton = await firstVisible(gifButtonLocators(page), 4_000);
  if (!gifButton) {
    await revealCommentComposer(page);
    gifButton = await firstVisible(gifButtonLocators(page), 4_000);
  }

  if (!gifButton) {
    if (debug) {
      await printVisibleCandidates(page, "Candidatos da área de comentários:", {
        commentsOnly: true,
      });
    }
    throw new Error(
      "Botão do seletor de GIF não encontrado. Execute com --show e consulte o diagnóstico de candidatos visíveis.",
    );
  }

  await gifButton.click();

  const gifPicker = await findGifPicker(page);
  if (!gifPicker) {
    throw new Error(
      "Painel de GIF não encontrado como dialog com textbox. Revise findGifPicker() em src/instagram.js conforme o DOM atual.",
    );
  }

  const term = randomItem(GIF_SEARCH_TERMS);
  console.log(`Termo de GIF: ${term}`);
  await gifPicker.textbox.fill(term);

  const results = await waitForGifResults(gifPicker.picker);
  if (results.length === 0) {
    if (debug) {
      await printVisibleCandidates(
        gifPicker.picker,
        "Candidatos visíveis dentro do picker de GIF:",
      );
    }
    throw new Error(
      "Nenhum resultado real de GIF foi reconhecido. Execute com --show e consulte o diagnóstico do picker.",
    );
  }

  await randomItem(results).click();

  // Atualmente, a seleção normalmente publica o GIF. Se a interface exibir um
  // passo de confirmação dentro do painel, use apenas botões com nome exato.
  if (await gifPicker.picker.isVisible().catch(() => false)) {
    const publishButton = await firstVisible(
      [
        gifPicker.picker.getByRole("button", {
          name: /^(Post|Publish|Send|Publicar|Enviar)$/i,
        }),
      ],
      2_000,
    );
    await publishButton?.click();
  }

  await waitForPickerToClose(gifPicker.picker);
}

function commentSubmitLocators(page, composer) {
  const submitName = /^(Post|Publicar|Send|Enviar|Comment|Comentar)$/i;
  const unambiguousSubmitName = /^(Post|Publicar|Send|Enviar)$/i;
  const form = composer.locator(
    'xpath=ancestor::*[self::form or @role="form"][1]',
  );
  const nearbyContainer = composer.locator(
    'xpath=ancestor::*[.//button or .//*[@role="button"]][1]',
  );

  return [
    form.locator('button[type="submit"], input[type="submit"]'),
    form.getByRole("button", { name: submitName }),
    nearbyContainer.getByRole("button", { name: submitName }),
    page.locator("main article").getByRole("button", { name: unambiguousSubmitName }),
    page
      .getByRole("article")
      .getByRole("button", { name: unambiguousSubmitName }),
  ];
}

async function fillCommentComposer(composer, comment) {
  const type = await composer.evaluate((element) => ({
    tag: element.tagName.toLowerCase(),
    contentEditable: element.getAttribute("contenteditable") === "true",
  }));

  if (type.contentEditable) await composer.click();

  if (["input", "textarea"].includes(type.tag) || type.contentEditable) {
    await composer.fill(comment);
    return;
  }

  throw new Error("O campo de comentário encontrado não aceita preenchimento.");
}

async function readCommentComposer(composer) {
  return composer
    .evaluate((element) => {
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        return element.value;
      }
      return element.textContent ?? "";
    })
    .catch(() => null);
}

async function waitForCommentSubmission(page, composer, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const currentValue = await readCommentComposer(composer);
    if (currentValue !== null && currentValue.trim() === "") return;

    if (currentValue === null) {
      const replacement = await firstVisible(commentComposerLocators(page), 500);
      const replacementValue = replacement
        ? await readCommentComposer(replacement)
        : null;
      if (replacementValue !== null && replacementValue.trim() === "") return;
    }

    await wait(250);
  }

  throw new Error("Não foi possível confirmar a publicação do comentário.");
}

async function measureStage(timing, name, action) {
  const started = performance.now();
  try {
    return await action();
  } finally {
    timing[name] = performance.now() - started;
  }
}

export async function performCommentAction(page, { debug = false, onTiming } = {}) {
  const started = performance.now();
  const timing = {};
  try {
    if (!(await isLoggedIn(page))) throw new AuthenticationRequiredError();
    if (
      !Array.isArray(COMMENT_TEXTS) ||
      COMMENT_TEXTS.length === 0 ||
      COMMENT_TEXTS.some(
        (comment) => typeof comment !== "string" || comment.trim().length === 0,
      )
    ) {
      throw new Error(
        "COMMENT_TEXTS deve conter somente strings não vazias.",
      );
    }

    const composer = await measureStage(timing, "composerMs", () => findCommentComposer(page));
    if (!composer) {
      if (debug) {
        await printVisibleCandidates(page, "Possíveis campos de comentário:", {
          commentsOnly: true,
        });
      }
      throw new Error("Campo de comentário não encontrado.");
    }

    const comment = randomItem(COMMENT_TEXTS);
    console.log(`Comentário selecionado: ${JSON.stringify(comment)}`);
    await measureStage(timing, "fillMs", () => fillCommentComposer(composer, comment));

    const submitButton = await measureStage(timing, "submitLookupMs", () =>
      firstVisible(commentSubmitLocators(page, composer), 3_000),
    );

    await measureStage(timing, "submitMs", async () => {
      if (submitButton) {
        await submitButton.click();
      } else {
        await composer.focus();
        const focused = await composer
          .evaluate(
            (element) =>
              document.activeElement === element ||
              element.contains(document.activeElement),
          )
          .catch(() => false);

        if (!focused) {
          throw new Error("Não foi possível focar o campo de comentário para enviar.");
        }
        await composer.press("Enter");
      }
    });

    await measureStage(timing, "confirmMs", () => waitForCommentSubmission(page, composer));
    console.log("Comentário publicado.");
  } finally {
    timing.totalMs = performance.now() - started;
    try {
      onTiming?.(timing);
    } catch {
      // Instrumentação não interfere na publicação.
    }
  }
}
