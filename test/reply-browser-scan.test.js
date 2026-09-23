import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { scanAndReplyToComments } from "../src/instagram-replies.js";
import { LedgerWriteError, loadReplyLedger } from "../src/reply-ledger.js";
import { RateLimitError } from "../src/instagram.js";
import { recyclePage } from "../src/page-health.js";

const targetPost = "https://www.instagram.com/p/test-post/";

function root({ id, author, manualReply = false, behavior = "success" }) {
  return `<div class="thread">
    <div class="row">
      <div class="content"><div class="metadata">
        <a href="/${author}/">${author}</a>
        <a href="/p/test-post/c/${id}/"><time>agora</time></a>
      </div><span>comentário ${id}</span></div>
      ${behavior === "no-composer" ? "" : `<button data-reply="${id}">Responder</button>
      <form hidden><textarea aria-label="Responder"></textarea>
        <button type="button" data-submit="${id}" data-behavior="${behavior}">Publicar</button>
      </form>`}
    </div>
    ${manualReply ? `<ul><li><a href="/atletica/">atletica</a>
      <a href="/p/test-post/c/manual-${id}/"><time>ontem</time></a>
      <span>resposta manual</span></li></ul>` : ""}
  </div>`;
}

async function fixture(page, comments) {
  await page.setContent(`<main>${comments.map(root).join("")}</main>`);
  await page.evaluate(() => {
    window.sent = [];
    for (const control of document.querySelectorAll("[data-reply]")) {
      control.addEventListener("click", () => {
        control.parentElement.querySelector("form").hidden = false;
      });
    }
    for (const submit of document.querySelectorAll("[data-submit]")) {
      submit.addEventListener("click", () => {
        const form = submit.closest("form");
        if (submit.dataset.behavior === "blocked") {
          const alert = document.createElement("div");
          alert.setAttribute("role", "alert");
          alert.textContent = "Try again later";
          document.body.append(alert);
          return;
        }
        if (submit.dataset.behavior === "no-confirmation") return;
        window.sent.push(submit.dataset.submit);
        form.querySelector("textarea").value = "";
      });
    }
  });
}

async function scan(page, ledger, options = {}) {
  return scanAndReplyToComments(page, {
    ledger,
    ownUsername: "@ATLETICA",
    replyText: "resposta fixa",
    intervalMs: 0,
    submissionTimeoutMs: 300,
    ...options,
  });
}

test("ledger do browser controla envio, replies manuais e restart", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Chromium indisponível: ${error.message}`);
    return;
  }
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "savanna-replies-"));
  const context = await browser.newContext();
  await context.addCookies([{
    name: "sessionid", value: "synthetic-test-session",
    domain: ".instagram.com", path: "/", expires: -1,
  }]);
  const page = await context.newPage();

  try {
    const ledger = await loadReplyLedger({ stateDir, profile: "atletica", targetPost });
    await fixture(page, [
      { id: "a", author: "pedro" },
      { id: "b", author: "pedro" },
      { id: "c", author: "joao", manualReply: true },
      { id: "d", author: "@ATLETICA" },
      { id: "e", author: "maria" },
    ]);
    const first = await scan(page, ledger, { maxPerScan: 4 });
    assert.equal(first.repliesSent, 4);
    assert.equal(first.ownComments, 1);
    assert.deepEqual(await page.evaluate(() => window.sent), ["a", "c", "e", "b"]);
    assert.equal(ledger.size, 4);
    assert.equal(ledger.has("/c/c/"), true);
    const persisted = (await readFile(ledger.filePath, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(persisted.length, 4);
    assert.ok(persisted.every((record) => record.profile === "atletica"));
    assert.ok(persisted.every((record) => record.targetPost === targetPost));

    const restarted = await loadReplyLedger({ stateDir, profile: "atletica", targetPost });
    const second = await scan(page, restarted);
    assert.equal(second.repliesSent, 0);
    assert.equal(second.alreadyProcessed, 4);
    assert.equal(second.ownComments, 1);
    assert.deepEqual(await page.evaluate(() => window.sent), ["a", "c", "e", "b"]);

    const otherPost = await loadReplyLedger({
      stateDir, profile: "atletica", targetPost: "https://www.instagram.com/p/other/",
    });
    const otherProfile = await loadReplyLedger({ stateDir, profile: "outro", targetPost });
    assert.equal(otherPost.size, 0);
    assert.equal(otherProfile.size, 0);
  } finally {
    await context.close();
    await browser.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("falhas antes e durante o submit não entram no ledger", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Chromium indisponível: ${error.message}`);
    return;
  }
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "savanna-replies-"));
  const context = await browser.newContext();
  await context.addCookies([{
    name: "sessionid", value: "synthetic-test-session",
    domain: ".instagram.com", path: "/", expires: -1,
  }]);
  const page = await context.newPage();
  try {
    const ledger = await loadReplyLedger({ stateDir, profile: "atletica", targetPost });
    await fixture(page, [
      { id: "before", author: "pedro", behavior: "no-composer" },
      { id: "submit", author: "joao", behavior: "no-confirmation" },
    ]);
    const stats = await scan(page, ledger);
    assert.equal(stats.errors, 2);
    assert.equal(stats.repliesSent, 0);
    assert.equal(ledger.size, 0);
    assert.deepEqual(await page.evaluate(() => window.sent), []);
  } finally {
    await context.close();
    await browser.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("rate limit interrompe o scan e não marca o comentário", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Chromium indisponível: ${error.message}`);
    return;
  }
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "savanna-replies-"));
  const context = await browser.newContext();
  await context.addCookies([{
    name: "sessionid", value: "synthetic-test-session",
    domain: ".instagram.com", path: "/", expires: -1,
  }]);
  const page = await context.newPage();
  try {
    const ledger = await loadReplyLedger({ stateDir, profile: "atletica", targetPost });
    await fixture(page, [
      { id: "blocked", author: "pedro", behavior: "blocked" },
      { id: "later", author: "joao" },
    ]);
    await assert.rejects(scan(page, ledger), RateLimitError);
    assert.equal(ledger.size, 0);
    assert.deepEqual(await page.evaluate(() => window.sent), []);
  } finally {
    await context.close();
    await browser.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("falha ao gravar o ledger interrompe envios seguintes", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Chromium indisponível: ${error.message}`);
    return;
  }
  const context = await browser.newContext();
  await context.addCookies([{
    name: "sessionid", value: "synthetic-test-session",
    domain: ".instagram.com", path: "/", expires: -1,
  }]);
  const page = await context.newPage();
  try {
    await fixture(page, [
      { id: "first", author: "pedro" },
      { id: "second", author: "joao" },
    ]);
    const ledger = {
      has: () => false,
      markProcessed: async () => { throw new LedgerWriteError("disco indisponível"); },
    };
    await assert.rejects(scan(page, ledger), LedgerWriteError);
    assert.deepEqual(await page.evaluate(() => window.sent), ["first"]);
  } finally {
    await context.close();
    await browser.close();
  }
});

test("reply continua em nova Page sem duplicar itens presentes no ledger", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Chromium indisponível: ${error.message}`);
    return;
  }
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "savanna-replies-"));
  const context = await browser.newContext();
  await context.addCookies([{
    name: "sessionid", value: "synthetic-test-session",
    domain: ".instagram.com", path: "/", expires: -1,
  }]);
  const comments = [
    { id: "a", author: "pedro" },
    { id: "b", author: "joao" },
    { id: "c", author: "maria" },
    { id: "d", author: "ana" },
  ];
  const oldPage = await context.newPage();
  try {
    const ledger = await loadReplyLedger({ stateDir, profile: "atletica", targetPost });
    await fixture(oldPage, comments);
    const first = await scan(oldPage, ledger, { maxPerScan: 2 });
    assert.equal(first.repliesSent, 2);
    const firstSent = await oldPage.evaluate(() => window.sent);

    const newPage = await recyclePage(context, oldPage, (candidate) => fixture(candidate, comments));
    assert.equal(oldPage.isClosed(), true);
    const second = await scan(newPage, ledger, { maxPerScan: 2 });
    const secondSent = await newPage.evaluate(() => window.sent);
    assert.equal(second.repliesSent, 2);
    assert.equal(ledger.size, 4);
    assert.equal(new Set([...firstSent, ...secondSent]).size, 4);
  } finally {
    await context.close();
    await browser.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
