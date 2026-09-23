import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("browser reply recicla no limite e continua sem reenviar itens do ledger", () => {
  const script = `
    import { registerHooks } from 'node:module';
    import { pathToFileURL } from 'node:url';
    import path from 'node:path';

    process.env.INSTAGRAM_USERNAME = 'atletica';
    process.env.REPLY_TEXT = 'resposta fixa';
    process.env.REPLY_INTERVAL_MS = '0';
    process.env.REPLY_PAGE_RECYCLE_EVERY = '2';
    globalThis.targetPost = 'https://www.instagram.com/p/DdhsVOdTe42/';
    globalThis.events = [];
    globalThis.processed = new Set();
    globalThis.oldPage = {
      id: 'old', currentUrl: 'about:blank',
      url() { return this.currentUrl; },
      isClosed() { return false; },
      async close() { globalThis.events.push('close:old'); },
    };
    globalThis.context = {
      pages: () => [globalThis.oldPage],
      async newPage() {
        globalThis.events.push('newPage:same-context');
        return {
          id: 'new', currentUrl: 'about:blank',
          url() { return this.currentUrl; },
          isClosed() { return false; },
          async close() { globalThis.events.push('close:new'); },
        };
      },
      async close() { globalThis.events.push('close:context'); },
    };

    const mocks = {
      'browser.js': \`
        export async function launchBrowser() { return globalThis.context; }
        export async function getMainPage(context) { return context.pages()[0]; }
        export async function hasCompletedInitialLogin() { return true; }
        export async function markInitialLoginComplete() {}
      \`,
      'instagram.js': \`
        export class AuthenticationRequiredError extends Error {}
        export class RateLimitError extends Error {}
        export async function ensureLoggedIn() { return true; }
        export async function isLoggedIn() { return true; }
        export function isOnTargetPost(page) { return page.url() === globalThis.targetPost; }
        export async function openInstagramHome(page) { page.currentUrl = 'https://www.instagram.com/'; }
        export async function openTargetPost(page) {
          globalThis.events.push('open:' + page.id);
          page.currentUrl = globalThis.targetPost;
        }
      \`,
      'instagram-replies.js': \`
        export async function waitForCommentsArea() {}
        export async function scanAndReplyToComments(page, options) {
          globalThis.events.push('scan:' + page.id + ':max' + options.maxPerScan);
          const stats = {
            commentsAnalyzed: 3, alreadyProcessed: 0, repliesSent: 0,
            ownComments: 0, errors: 0,
          };
          for (const key of ['a', 'b', 'c']) {
            if (options.ledger.has(key)) {
              stats.alreadyProcessed += 1;
              continue;
            }
            await options.ledger.markProcessed(key);
            globalThis.events.push('sent:' + key);
            stats.repliesSent += 1;
            await options.onReply({ durationMs: 1, sentAt: Date.now() });
            if (stats.repliesSent >= options.maxPerScan) break;
          }
          if (page.id === 'new') process.emit('SIGTERM');
          return stats;
        }
      \`,
      'profile-lock.js': \`
        export class ProfileInUseError extends Error {}
        export async function acquireProfileLock() { return { release: async () => {} }; }
      \`,
      'reply-ledger.js': \`
        export class LedgerWriteError extends Error {}
        export async function loadReplyLedger() {
          return {
            get size() { return globalThis.processed.size; },
            has: (key) => globalThis.processed.has(key),
            markProcessed: async (key) => { globalThis.processed.add(key); },
          };
        }
      \`,
    };
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (context.parentURL?.endsWith('/src/reply-browser-mode.js')) {
          const source = mocks[specifier.slice(2)];
          if (source) return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
        }
        return nextResolve(specifier, context);
      },
    });
    const file = pathToFileURL(path.resolve('src/reply-browser-mode.js')).href;
    const { runBrowserReplyMode } = await import(file);
    await runBrowserReplyMode({ profile: 'recycletest', show: false });
    console.log('EVENTS=' + JSON.stringify(globalThis.events));
  `;

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: path.resolve(), encoding: "utf8", timeout: 5_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 143, result.stderr);
  const events = JSON.parse(result.stdout.match(/EVENTS=(\[[^\r\n]+\])/)?.[1] ?? "null");
  assert.ok(events, result.stdout);
  assert.deepEqual(events.filter((event) => event.startsWith("sent:")), ["sent:a", "sent:b", "sent:c"]);
  assert.deepEqual(events.filter((event) => event.startsWith("scan:")), [
    "scan:old:max2", "scan:new:max2",
  ]);
  assert.ok(events.indexOf("open:new") < events.indexOf("close:old"));
  assert.ok(events.indexOf("close:old") < events.indexOf("scan:new:max2"));
});
