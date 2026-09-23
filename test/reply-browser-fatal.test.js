import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("LedgerWriteError encerra o browser reply mode sem outro scan", () => {
  const childScript = `
    import { registerHooks } from 'node:module';
    import { pathToFileURL } from 'node:url';
    import path from 'node:path';
    import { LedgerWriteError } from './src/reply-ledger.js';
    import { TARGET_POST } from './config.js';

    globalThis.LedgerWriteError = LedgerWriteError;
    globalThis.targetPost = TARGET_POST;
    globalThis.currentUrl = 'about:blank';
    globalThis.scanCount = 0;
    process.env.INSTAGRAM_USERNAME = 'atletica';
    process.env.REPLY_TEXT = 'resposta fixa';
    process.env.REPLY_SCAN_INTERVAL_MS = '1';

    const mocks = {
      'browser.js': \`
        export async function launchBrowser() {
          const page = { isClosed: () => false, url: () => globalThis.currentUrl };
          return { pages: () => [page], close: async () => {} };
        }
        export async function getMainPage(context) { return context.pages()[0]; }
        export async function hasCompletedInitialLogin() { return true; }
        export async function markInitialLoginComplete() {}
      \`,
      'instagram.js': \`
        export class AuthenticationRequiredError extends Error {}
        export class RateLimitError extends Error {}
        export async function ensureLoggedIn() { return true; }
        export async function isLoggedIn() { return true; }
        export function isOnTargetPost() { return globalThis.currentUrl === globalThis.targetPost; }
        export async function openInstagramHome() { globalThis.currentUrl = 'https://www.instagram.com/'; }
        export async function openTargetPost() { globalThis.currentUrl = globalThis.targetPost; }
      \`,
      'instagram-replies.js': \`
        export async function waitForCommentsArea() {}
        export async function scanAndReplyToComments() {
          globalThis.scanCount += 1;
          throw new globalThis.LedgerWriteError('disco indisponível');
        }
      \`,
      'profile-lock.js': \`
        export class ProfileInUseError extends Error {}
        export async function acquireProfileLock() {
          return { release: async () => {} };
        }
      \`,
    };

    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (context.parentURL?.endsWith('/src/reply-browser-mode.js')) {
          const source = mocks[specifier.slice(2)];
          if (source) {
            return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
          }
        }
        return nextResolve(specifier, context);
      },
    });

    const file = pathToFileURL(path.resolve('src/reply-browser-mode.js')).href;
    const { runBrowserReplyMode } = await import(file);
    await runBrowserReplyMode({ profile: 'fataltest', show: false });
    console.log('SCAN_COUNT=' + globalThis.scanCount);
    console.log('EXIT_CODE=' + process.exitCode);
  `;

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childScript], {
    cwd: path.resolve(),
    encoding: "utf8",
    timeout: 5_000,
  });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /SCAN_COUNT=1/);
  assert.match(result.stdout, /EXIT_CODE=1/);
  assert.match(result.stderr, /Uma reply pode ter sido enviada sem registro/);
  assert.match(result.stderr, /Corrija o armazenamento antes de reiniciar/);
  assert.doesNotMatch(result.stdout, /Próxima varredura/);
});
