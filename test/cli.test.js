import assert from "node:assert/strict";
import test from "node:test";
import { parseCliArgs } from "../src/cli.js";

test("mantém o comando legado no modo comment", () => {
  assert.deepEqual(parseCliArgs(["--profile", "pedro"]), {
    mode: "comment",
    profile: "pedro",
    replyDriver: undefined,
    show: false,
  });
});

test("aceita comment explícito com --show", () => {
  assert.deepEqual(
    parseCliArgs(["--mode", "comment", "--profile", "pedro", "--show"]),
    {
      mode: "comment",
      profile: "pedro",
      replyDriver: undefined,
      show: true,
    },
  );
});

test("usa api como reply driver padrão", () => {
  assert.equal(parseCliArgs(["--mode", "reply"]).replyDriver, "api");
});

test("aceita os dois formatos do browser driver", () => {
  assert.equal(
    parseCliArgs([
      "--mode=reply",
      "--reply-driver=browser",
      "--profile=atletica",
      "--show",
    ]).replyDriver,
    "browser",
  );
  assert.equal(
    parseCliArgs([
      "--mode",
      "reply",
      "--reply-driver",
      "browser",
      "--profile",
      "atletica",
    ]).replyDriver,
    "browser",
  );
});

test("valida combinações incompatíveis", () => {
  assert.throws(
    () => parseCliArgs(["--mode", "reply", "--reply-driver", "browser"]),
    /--profile.*browser/,
  );
  assert.throws(
    () =>
      parseCliArgs(["--mode", "reply", "--reply-driver", "api", "--show"]),
    /--show.*api/,
  );
  assert.throws(
    () => parseCliArgs(["--mode", "reply", "--reply-driver", "xyz"]),
    /Reply driver inválido/,
  );
  assert.throws(
    () =>
      parseCliArgs([
        "--mode",
        "comment",
        "--profile",
        "pedro",
        "--reply-driver",
        "api",
      ]),
    /só pode ser usado no modo reply/,
  );
});
