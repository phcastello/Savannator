import { chromium } from "playwright";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";

const INITIAL_LOGIN_MARKER = ".initial-login-complete";

export async function launchBrowser(profileDir, { headless }) {
  return chromium.launchPersistentContext(profileDir, {
    headless,
    ...(headless ? {} : { viewport: null }),
  });
}

export async function getMainPage(context) {
  return context.pages()[0] ?? context.newPage();
}

export async function hasCompletedInitialLogin(profileDir) {
  try {
    await access(path.join(profileDir, INITIAL_LOGIN_MARKER));
    return true;
  } catch {
    return false;
  }
}

export async function markInitialLoginComplete(profileDir) {
  await writeFile(
    path.join(profileDir, INITIAL_LOGIN_MARKER),
    `${new Date().toISOString()}\n`,
    "utf8",
  );
}
