export const TARGET_POST =
  "https://www.instagram.com/p/DdhsVOdTe42/";

export const INTERVAL_MS = 1_500;
export const ACTION_LIMIT = 1_000_000;
export const RATE_LIMIT_FALLBACK_MS = 15 * 60 * 1000;
export const COMMENT_PAGE_RECYCLE_EVERY = Number(
  process.env.COMMENT_PAGE_RECYCLE_EVERY ?? 100,
);

export const COMMENT_TEXTS = [
  "🔥",
  "💙🧡",
  "Boraaaa 💙🧡",
  "🧡💙🦡",
  "🦡",
];

export const GIF_SEARCH_TERMS = [
  "party",
  "celebration",
  "dance",
  "funny",
];
