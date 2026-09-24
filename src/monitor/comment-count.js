import { openInstagramPost } from "../instagram.js";

// A expressão completa impede interpretar 47.5K como 47 ou 47.5.
const EXACT_NUMBER = /^(?:\d{1,3}(?:[., \u00a0\u202f]\d{3})+|\d+)$/u;
const NUMBER_TOKEN = "([\\d.,\\s\\u00a0\\u202f]+(?:[KMB]|mil(?:h(?:ão|ões))?)?)";
const PATTERNS = [
  new RegExp(`(?:view\\s+all|see\\s+all|ver\\s+todos(?:\\s+os)?|mostrar\\s+todos(?:\\s+os)?)\\s+${NUMBER_TOKEN}\\s*(?:comments?|comentários?)`, "iu"),
  new RegExp(`${NUMBER_TOKEN}\\s*(?:comments?|comentários?)(?:\\b|$)`, "iu"),
  new RegExp(`(?:comments?|comentários?)\\s*[:(]\\s*${NUMBER_TOKEN}`, "iu"),
];

export function parseCommentCount(text) {
  if (typeof text !== "string") return null;
  for (const pattern of PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    const raw = match[1].trim();
    if (!EXACT_NUMBER.test(raw)) return null;
    const count = Number(raw.replace(/[., \u00a0\u202f]/gu, ""));
    return Number.isSafeInteger(count) ? count : null;
  }
  return null;
}

function structuredCount(data) {
  if (!data || typeof data !== "object") return null;
  const stack = [data];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) { stack.push(...node); continue; }
    const type = node.interactionType;
    const isComment = typeof type === "string"
      ? /CommentAction/i.test(type)
      : typeof type === "object" && /CommentAction/i.test(String(type?.["@type"]));
    if (isComment) {
      const raw = node.userInteractionCount;
      if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) return raw;
      if (typeof raw === "string" && EXACT_NUMBER.test(raw.trim())) {
        return Number(raw.replace(/[., \u00a0\u202f]/gu, ""));
      }
    }
    stack.push(...Object.values(node));
  }
  return null;
}

export function extractHydratedCommentCount(scriptTexts, postUrl) {
  let shortcode;
  try { shortcode = new URL(postUrl).pathname.match(/^\/p\/([^/]+)\/?$/)?.[1]; }
  catch { return null; }
  if (!shortcode) return null;

  const matches = [];
  for (const raw of scriptTexts) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; }
    const stack = [{ value: parsed, path: "", depth: 0 }];
    while (stack.length) {
      const { value, path, depth } = stack.pop();
      if (typeof value === "string") {
        if (depth < 3 && value.includes("comment_count") && /^[\[{]/.test(value.trim())) {
          try { stack.push({ value: JSON.parse(value), path, depth: depth + 1 }); } catch { /* não é JSON aninhado */ }
        }
        continue;
      }
      if (!value || typeof value !== "object") continue;
      if (value.code === shortcode && Number.isSafeInteger(value.comment_count) && value.comment_count >= 0) {
        matches.push({ count: value.comment_count, mainPost: path.includes("media__shortcode__web_info") });
      }
      for (const [key, child] of Object.entries(value)) {
        if (child && typeof child === "object" || typeof child === "string" && child.includes("comment_count")) {
          stack.push({ value: child, path: `${path}.${key}`, depth });
        }
      }
    }
  }
  return matches.find((match) => match.mainPost)?.count ?? matches[0]?.count ?? null;
}

export async function extractPostCommentCount(page, postUrl = page.url()) {
  // Controles semânticos e metadados: nunca conta nós de comentários.
  const candidates = await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const controls = [...document.querySelectorAll("a, button, [role=button]")]
      .filter(visible)
      .map((element) => ({ text: element.textContent?.trim() ?? "", aria: element.getAttribute("aria-label") ?? "" }))
      .filter(({ text, aria }) => /comment|comentár/i.test(text + aria))
      .slice(0, 100);
    const aria = [...document.querySelectorAll("[aria-label]")]
      .filter(visible)
      .map((element) => element.getAttribute("aria-label") ?? "")
      .filter((label) => /comment|comentár/i.test(label))
      .slice(0, 100);
    const visibleText = [...document.querySelectorAll("span, [role=link]")]
      .filter(visible)
      .map((element) => element.textContent?.trim() ?? "")
      .filter((value) => value.length <= 120 && /comment|comentár/i.test(value))
      .slice(0, 100);
    const metadata = [...document.querySelectorAll('meta[property="og:description"], meta[name="description"], meta[property="description"]')]
      .map((element) => element.getAttribute("content") ?? "");
    const structured = [...document.querySelectorAll('script[type="application/ld+json"]')]
      .map((element) => element.textContent ?? "");
    const hydrated = [...document.querySelectorAll('script[type="application/json"]')]
      .map((element) => element.textContent ?? "")
      .filter((raw) => raw.length <= 2_000_000 && raw.includes("comment_count"));
    return { controls, aria, visibleText, metadata, structured, hydrated };
  });

  for (const control of candidates.controls) {
    const count = parseCommentCount(control.text);
    if (count !== null) return { count, method: "visible_comment_control" };
  }
  for (const label of candidates.aria.concat(candidates.controls.map((control) => control.aria))) {
    const count = parseCommentCount(label);
    if (count !== null) return { count, method: "aria_label" };
  }
  for (const value of candidates.visibleText) {
    const count = parseCommentCount(value);
    if (count !== null) return { count, method: "visible_comment_text" };
  }
  for (const metadata of candidates.metadata) {
    const count = parseCommentCount(metadata);
    if (count !== null) return { count, method: "metadata" };
  }
  for (const raw of candidates.structured) {
    try {
      const count = structuredCount(JSON.parse(raw));
      if (count !== null) return { count, method: "structured_data" };
    } catch { /* JSON-LD inválido: tentar a próxima fonte. */ }
  }
  const hydratedCount = extractHydratedCommentCount(candidates.hydrated, postUrl);
  if (hydratedCount !== null) return { count: hydratedCount, method: "hydrated_media" };
  throw new Error("Contador total exato indisponível neste post; nenhuma amostra foi salva.");
}

export async function getPostCommentCount(page, postUrl) {
  await openInstagramPost(page, postUrl);
  // O contador pode surgir após o DOMContentLoaded; espera breve sem paginar comentários.
  const deadline = Date.now() + 10_000;
  do {
    try { return await extractPostCommentCount(page, postUrl); }
    catch (error) {
      if (Date.now() >= deadline) throw error;
      await page.waitForTimeout(500);
    }
  } while (true);
}
