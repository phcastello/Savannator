import assert from "node:assert/strict";
import test from "node:test";
import { createInteractionMeter, interactionBand } from "../src/interaction-meter.js";

test("faixas de interações por minuto passam por vermelho, amarelo, verde e azul", () => {
  assert.equal(interactionBand(7).name, "VERMELHO");
  assert.equal(interactionBand(8).name, "AMARELO");
  assert.equal(interactionBand(14).name, "AMARELO");
  assert.equal(interactionBand(15).name, "VERDE");
  assert.equal(interactionBand(29).name, "VERDE");
  assert.equal(interactionBand(30).name, "AZUL");
});

test("medidor conta só interações confirmadas nos últimos 60 segundos", () => {
  let time = 0;
  const lines = [];
  const meter = createInteractionMeter("comment", {
    now: () => time,
    write: (line) => lines.push(line),
    colors: false,
  });
  for (let index = 0; index < 30; index += 1) meter.record();
  assert.match(lines.at(-1), /30\/min AZUL/);
  time = 60_000;
  assert.equal(meter.record(), 1);
  assert.match(lines.at(-1), /1\/min VERMELHO/);
});

test("medidor usa cores ANSI quando o terminal aceita", () => {
  const lines = [];
  const meter = createInteractionMeter("reply", {
    now: () => 0,
    write: (line) => lines.push(line),
    colors: true,
  });
  for (let index = 0; index < 8; index += 1) meter.record();
  assert.match(lines[0], /\x1b\[31m1\/min VERMELHO\x1b\[0m/);
  assert.match(lines[7], /\x1b\[33m8\/min AMARELO\x1b\[0m/);
});
