import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { performCommentAction } from "../src/instagram.js";

test("comment mede etapas e preserva fallback semântico do composer", async (t) => {
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
    await page.setContent(`<main><article><form>
      <textarea aria-label="Add a comment"></textarea>
      <button type="submit">Post</button>
    </form></article></main>`);
    await page.evaluate(() => {
      window.sent = [];
      document.querySelector("form").addEventListener("submit", (event) => {
        event.preventDefault();
        const composer = document.querySelector("textarea");
        window.sent.push(composer.value);
        composer.value = "";
      });
    });
    const timings = [];
    await performCommentAction(page, { onTiming: (value) => timings.push(value) });
    await page.locator("textarea").evaluate((element) => {
      element.removeAttribute("aria-label");
      element.setAttribute("placeholder", "Add a comment");
    });
    await performCommentAction(page, { onTiming: (value) => timings.push(value) });

    assert.equal((await page.evaluate(() => window.sent)).length, 2);
    assert.equal(timings.length, 2);
    for (const timing of timings) {
      for (const key of ["totalMs", "composerMs", "fillMs", "submitLookupMs", "submitMs", "confirmMs"]) {
        assert.ok(Number.isFinite(timing[key]) && timing[key] >= 0, key);
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }
});
