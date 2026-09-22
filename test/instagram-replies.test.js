import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import {
  expandCommentReplies,
  findLoadedComments,
  hasOwnBrowserReply,
  openReplyComposer,
  submitReply,
} from "../src/instagram-replies.js";

test("distingue comentários raiz, replies e respostas da própria conta", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Chromium indisponível: ${error.message}`);
    return;
  }

  try {
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: "sessionid",
        value: "synthetic-test-session",
        domain: ".instagram.com",
        path: "/",
        expires: -1,
      },
    ]);
    const page = await context.newPage();
    await page.setContent(`
      <main>
        <div style="height:300px; overflow-y:auto">
          <div class="thread" data-thread="a">
            <div class="comment-row">
              <div class="content">
                <div class="metadata">
                  <a href="/usuario_a/">usuario_a</a>
                  <span><a href="/p/post/c/a/"><time datetime="2026-09-22">agora</time></a></span>
                </div>
                <span>qual horário?</span>
              </div>
              <div role="button" data-reply="a">Responder</div>
              <form style="display:none">
                <textarea aria-label="Responder"></textarea>
                <button type="button" data-submit="a">Publicar</button>
              </form>
            </div>
          </div>

          <div class="thread" data-thread="b">
            <div class="comment-row">
              <div class="content">
                <div class="metadata">
                  <a href="/usuario_b/">usuario_b</a>
                  <span><a href="/p/post/c/b/"><time>ontem</time></a></span>
                </div>
                <span>vai ser onde?</span>
              </div>
              <div role="button">Responder</div>
            </div>
            <ul>
              <div class="reply-row">
                <div class="content">
                  <div class="metadata">
                    <a href="/atletica/">atletica</a>
                    <span><a href="/p/post/c/reply-b/"><time>ontem</time></a></span>
                  </div>
                  <span>no ginásio</span>
                </div>
                <div role="button">Responder</div>
              </div>
            </ul>
          </div>

          <div class="thread" data-thread="c">
            <div class="comment-row">
              <div class="content">
                <div class="metadata">
                  <a href="/atletica/">atletica</a>
                  <span><a href="/p/post/c/c/"><time>ontem</time></a></span>
                </div>
                <span>aviso oficial</span>
              </div>
              <div role="button">Responder</div>
            </div>
          </div>

          <div class="thread" data-thread="d">
            <div class="comment-row">
              <div class="content">
                <div class="metadata">
                  <a href="/usuario_c/">usuario_c</a>
                  <span><a href="/p/post/c/d/"><time>ontem</time></a></span>
                </div>
                <span>tem ingresso?</span>
              </div>
              <div role="button">Responder</div>
            </div>
            <div role="button" data-expand="d">Ver 1 resposta</div>
          </div>
        </div>
      </main>
    `);
    await page.evaluate(() => {
      const replyMarkup = (id, text) => `
        <ul>
          <div class="reply-row">
            <div class="content">
              <div class="metadata">
                <a href="/atletica/">atletica</a>
                <span><a href="/p/post/c/${id}/"><time>agora</time></a></span>
              </div>
              <span>${text}</span>
            </div>
            <div role="button">Responder</div>
          </div>
        </ul>`;

      document.querySelector('[data-reply="a"]').addEventListener("click", () => {
        document.querySelector('[data-thread="a"] form').style.display = "block";
      });
      document.querySelector('[data-submit="a"]').addEventListener("click", () => {
        const thread = document.querySelector('[data-thread="a"]');
        const field = thread.querySelector("textarea");
        thread.insertAdjacentHTML("beforeend", replyMarkup("reply-a", field.value));
        field.value = "";
      });
      document.querySelector('[data-expand="d"]').addEventListener("click", (event) => {
        const thread = document.querySelector('[data-thread="d"]');
        thread.insertAdjacentHTML("beforeend", replyMarkup("reply-d", "sim"));
        event.currentTarget.remove();
      });
    });

    const comments = await findLoadedComments(page);
    assert.deepEqual(
      comments.map((comment) => comment.author),
      ["usuario_a", "usuario_b", "atletica", "usuario_c"],
    );

    const [withoutReply, manuallyReplied] = comments;
    assert.equal(
      await hasOwnBrowserReply(page, withoutReply, "@ATLETICA"),
      false,
    );
    assert.equal(
      await hasOwnBrowserReply(page, manuallyReplied, "atletica"),
      true,
    );

    const replyHiddenBehindControl = comments[3];
    assert.equal(
      await hasOwnBrowserReply(page, replyHiddenBehindControl, "atletica"),
      false,
    );
    await expandCommentReplies(page, replyHiddenBehindControl);
    assert.equal(
      await hasOwnBrowserReply(page, replyHiddenBehindControl, "atletica"),
      true,
    );
    assert.equal((await findLoadedComments(page)).length, 4);

    const composer = await openReplyComposer(page, withoutReply);
    assert.equal(
      await hasOwnBrowserReply(page, withoutReply, "atletica"),
      false,
    );
    await submitReply(page, composer, "resposta fixa");
    assert.equal(
      await hasOwnBrowserReply(page, withoutReply, "atletica"),
      true,
    );

    await context.close();
  } finally {
    await browser.close();
  }
});
