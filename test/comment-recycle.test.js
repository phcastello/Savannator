import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

function runCommentScenario(scenario, every) {
  const script = `
    import { registerHooks } from 'node:module';
    import { pathToFileURL } from 'node:url';
    import path from 'node:path';

    process.argv = ['node', 'src/index.js', '--profile', 'test'];
    process.env.COMMENT_PAGE_RECYCLE_EVERY = String(${every});
    globalThis.scenario = ${JSON.stringify(scenario)};
    globalThis.events = [];
    globalThis.targetPost = 'https://www.instagram.com/p/DdhsVOdTe42/';
    globalThis.commentCalls = 0;
    globalThis.makePage = (id) => ({
      id,
      currentUrl: 'about:blank',
      url() { return this.currentUrl; },
      isClosed() { return false; },
      async close() { globalThis.events.push('close:' + id); },
    });
    globalThis.oldPage = globalThis.makePage('old');
    globalThis.context = {
      pages: () => [globalThis.oldPage],
      async newPage() {
        globalThis.events.push('newPage:same-context');
        if (globalThis.scenario === 'create_fail') throw new Error('nova Page indisponível');
        return globalThis.makePage('new');
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
        export class RateLimitError extends Error {
          constructor() { super('429'); this.name = 'RateLimitError'; this.retryAfterMs = 1; }
        }
        export async function ensureLoggedIn() { return true; }
        export async function isLoggedIn() { return true; }
        export function isOnTargetPost(page) { return page.url() === globalThis.targetPost; }
        export async function openInstagramHome(page) { page.currentUrl = 'https://www.instagram.com/'; }
        export async function openTargetPost(page) {
          globalThis.events.push('open:' + page.id);
          page.currentUrl = globalThis.targetPost;
        }
        export async function performCommentAction(page, { onTiming }) {
          globalThis.commentCalls += 1;
          globalThis.events.push('comment:' + page.id + ':' + globalThis.commentCalls);
          onTiming({ totalMs: 100, composerMs: 10, submitLookupMs: 10 });
          if (globalThis.scenario === 'rate' && globalThis.commentCalls === 1) {
            throw new RateLimitError();
          }
        }
      \`,
      'profile-lock.js': \`
        export class ProfileInUseError extends Error {}
        export async function acquireProfileLock() { return { release: async () => {} }; }
      \`,
      'scheduler.js': \`
        export async function runScheduler({ action }) {
          const count = globalThis.scenario === 'rate' ? 2 : 3;
          for (let index = 0; index < count; index += 1) {
            try { await action(); } catch (error) { globalThis.events.push('error:' + error.name); }
          }
        }
      \`,
    };
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (context.parentURL?.endsWith('/src/index.js')) {
          const source = mocks[specifier.slice(2)];
          if (source) return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
        }
        return nextResolve(specifier, context);
      },
    });
    await import(pathToFileURL(path.resolve('src/index.js')).href);
    console.log('EVENTS=' + JSON.stringify(globalThis.events));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: path.resolve(),
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  const events = JSON.parse(result.stdout.match(/EVENTS=(\[[^\r\n]+\])/)?.[1] ?? "null");
  assert.ok(events, result.stdout);
  return events;
}

test("comment recicla após N publicações no mesmo BrowserContext e fecha a antiga depois do post", () => {
  const events = runCommentScenario("normal", 2);
  assert.deepEqual(events.filter((event) => event.startsWith("comment:")), [
    "comment:old:1", "comment:old:2", "comment:new:3",
  ]);
  const created = events.indexOf("newPage:same-context");
  const opened = events.indexOf("open:new");
  const closed = events.indexOf("close:old");
  assert.ok(created >= 0 && created < opened && opened < closed);
  assert.ok(closed < events.indexOf("comment:new:3"));
});

test("COMMENT_PAGE_RECYCLE_EVERY=0 mantém a Page", () => {
  const events = runCommentScenario("normal", 0);
  assert.equal(events.some((event) => event.startsWith("newPage:")), false);
  assert.deepEqual(events.filter((event) => event.startsWith("comment:")), [
    "comment:old:1", "comment:old:2", "comment:old:3",
  ]);
});

test("falha ao criar Page mantém a antiga para comentar", () => {
  const events = runCommentScenario("create_fail", 2);
  assert.ok(events.includes("newPage:same-context"));
  assert.equal(events.includes("close:old"), false);
  assert.ok(events.includes("comment:old:3"));
});

test("429 na ação não dispara reciclagem para retry", () => {
  const events = runCommentScenario("rate", 1);
  assert.ok(events.includes("error:RateLimitError"));
  assert.equal(events.some((event) => event.startsWith("newPage:")), false);
  assert.ok(events.includes("comment:old:2"));
});
