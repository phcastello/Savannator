import assert from "node:assert/strict";
import test from "node:test";
import { loadBrowserReplyConfig } from "../src/reply-browser-mode.js";
import { loadReplyConfig } from "../src/reply-mode.js";

test("browser driver não exige credenciais da Graph API", () => {
  const config = loadBrowserReplyConfig({
    INSTAGRAM_USERNAME: "@atletica",
    REPLY_TEXT: "resposta fixa",
    REPLY_SCAN_INTERVAL_MS: "60000",
  });

  assert.equal(config.username, "atletica");
  assert.equal(config.replyText, "resposta fixa");
  assert.equal(config.replyIntervalMs, 3_000);
  assert.equal(config.maxPerScan, 0);
});

test("browser driver valida intervalo e limite próprios", () => {
  const base = {
    INSTAGRAM_USERNAME: "atletica",
    REPLY_TEXT: "resposta fixa",
  };
  assert.equal(
    loadBrowserReplyConfig({ ...base, REPLY_INTERVAL_MS: "1500", REPLY_MAX_PER_SCAN: "5" }).maxPerScan,
    5,
  );
  assert.throws(
    () => loadBrowserReplyConfig({ ...base, REPLY_INTERVAL_MS: "-1" }),
    /REPLY_INTERVAL_MS/,
  );
  assert.throws(
    () => loadBrowserReplyConfig({ ...base, REPLY_MAX_PER_SCAN: "1.5" }),
    /REPLY_MAX_PER_SCAN/,
  );
});

test("api driver continua exigindo suas credenciais", () => {
  assert.throws(
    () =>
      loadReplyConfig({
        INSTAGRAM_USERNAME: "atletica",
        REPLY_TEXT: "resposta fixa",
      }),
    /INSTAGRAM_ACCESS_TOKEN/,
  );
});
