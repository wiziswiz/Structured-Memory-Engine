#!/usr/bin/env node
const { shouldRecall, isAllAckWords } = require('../lib/recall-gate');

let passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  \u2717 ${msg}`); }
}

console.log('Test 1: Simple acknowledgments are gated');
{
  for (const ack of ['ok', 'okay', 'thanks', 'thank you', 'got it', 'lol', 'yes', 'no', 'cool.', 'hmm', 'k']) {
    const r = shouldRecall(ack);
    assert(r.shouldRecall === false, `Expected "${ack}" to be gated, got shouldRecall=${r.shouldRecall}`);
  }
  const thanksExclaim = shouldRecall('thanks!');
  assert(thanksExclaim.shouldRecall === false && thanksExclaim.reason === 'acknowledgment',
    `"thanks!" should be acknowledgment, got reason=${thanksExclaim.reason}`);
}

console.log('Test 2: Compound acknowledgments are gated');
{
  // These compound acks require the tokenized isAllAckWords approach.
  // A monolithic ^...$ regex can't handle commas or spaces between ack tokens.
  const compoundAcks = [
    'thanks, got it',
    'ok cool thanks',
    'thank you!',
    'got it, thanks',
    'yes thanks',
    'ok got it',
    'cool, thanks!',
    'noted, thanks',
    'perfect, thank you',
  ];
  for (const ack of compoundAcks) {
    const r = shouldRecall(ack);
    assert(r.shouldRecall === false && r.reason === 'acknowledgment',
      `"${ack}" should be gated as compound ack, got shouldRecall=${r.shouldRecall} reason=${r.reason}`);
  }

  // Negative cases: messages that LOOK ack-ish but contain content words
  const notAcks = [
    'thanks for the update on the redis migration',
    'got it working finally',
    'ok but what about the auth module',
    'yes i need help with this',
  ];
  for (const msg of notAcks) {
    const r = shouldRecall(msg);
    assert(r.shouldRecall === true,
      `"${msg}" should pass gate (has content words), got gated: ${r.reason}`);
  }
}

console.log('Test 3: Math expressions are gated');
{
  const cases = ['2 + 2', '100 * 0.5', '1+1=2', '3.14 * 2', '50%'];
  for (const m of cases) {
    const r = shouldRecall(m);
    assert(r.shouldRecall === false, `Expected "${m}" to be gated as math, got shouldRecall=${r.shouldRecall} reason=${r.reason}`);
  }
  const mixed = shouldRecall('what is 2 + 2');
  assert(mixed.shouldRecall === true, `"what is 2 + 2" should pass (has word chars), got gated: ${mixed.reason}`);
}

console.log('Test 4: System commands are gated');
{
  for (const cmd of ['/clear', '/reset', '/help', '/version', '/debug', '/quit', '/exit', '/status']) {
    const r = shouldRecall(cmd);
    assert(r.shouldRecall === false && r.reason === 'system command',
      `Expected "${cmd}" gated as system command, got shouldRecall=${r.shouldRecall} reason=${r.reason}`);
  }
}

console.log('Test 5: Real queries pass the gate');
{
  const queries = [
    'what did Sarah say about the project?',
    'tell me about Movement Labs',
    'how does the auth middleware work',
    'what happened last Thursday',
    'explain the scoring profile system',
  ];
  for (const q of queries) {
    const r = shouldRecall(q);
    assert(r.shouldRecall === true, `Expected "${q}" to pass gate, got gated: ${r.reason}`);
  }
}

console.log('Test 6: Short messages are gated');
{
  const r1 = shouldRecall('k');
  assert(r1.shouldRecall === false, `"k" should be gated, got shouldRecall=${r1.shouldRecall}`);
  const r2 = shouldRecall('');
  assert(r2.shouldRecall === false && r2.reason === 'empty', `Empty string should be empty, got ${r2.reason}`);
  const r3 = shouldRecall('  ', {});
  assert(r3.shouldRecall === false, `Whitespace should be gated, got shouldRecall=${r3.shouldRecall}`);
  const r4 = shouldRecall('hi', { recallGating: { minMessageLength: 10 } });
  assert(r4.shouldRecall === false && r4.reason === 'too short', `With minLength=10, "hi" should be too short, got ${r4.reason}`);
}

console.log('Test 7: Non-string inputs fail safe');
{
  assert(shouldRecall(null).shouldRecall === false, 'null should be gated');
  assert(shouldRecall(undefined).shouldRecall === false, 'undefined should be gated');
  assert(shouldRecall(42).shouldRecall === false, 'number should be gated');
}

console.log('Test 8: Gate integration with context.js — gated message returns empty');
{
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sme-gate-test-'));
  fs.mkdirSync(path.join(ws, '.memory'), { recursive: true });

  const { openDb } = require('../lib/store');
  const { getRelevantContext } = require('../lib/context');
  const db = openDb(ws);

  // Seed one chunk so DB has content
  db.prepare(`INSERT INTO chunks (file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'memory/test.md', 'Test', 'Sarah Chen is the lead engineer on Movement Labs',
    1, 1, JSON.stringify(['sarah chen', 'movement labs']), 'fact', 1.0,
    new Date().toISOString(), new Date().toISOString(), 1.0
  );

  // Gated: simple ack
  const gatedResult = getRelevantContext(db, 'ok', { workspace: ws });
  assert(gatedResult.gated === true, `Expected gated=true for "ok", got ${JSON.stringify(gatedResult)}`);
  assert(gatedResult.text === '', 'Expected empty text for gated message');
  assert(gatedResult.chunks.length === 0, 'Expected no chunks for gated message');
  assert(gatedResult.gateReason === 'acknowledgment', `Expected reason=acknowledgment, got ${gatedResult.gateReason}`);

  // Gated: compound ack (regression for tokenized isAllAckWords)
  const compoundGated = getRelevantContext(db, 'thanks, got it', { workspace: ws });
  assert(compoundGated.gated === true, `Expected gated=true for "thanks, got it", got ${JSON.stringify(compoundGated)}`);
  assert(compoundGated.gateReason === 'acknowledgment', `Expected acknowledgment, got ${compoundGated.gateReason}`);

  // Real query: not gated
  const realResult = getRelevantContext(db, 'tell me about Sarah Chen', { workspace: ws });
  assert(realResult.gated !== true, `Real query should not be gated, got ${JSON.stringify({gated: realResult.gated})}`);

  // skipGate override
  const bypassResult = getRelevantContext(db, 'ok', { workspace: ws, skipGate: true });
  assert(bypassResult.gated !== true, 'skipGate should bypass the gate');

  // recallGating.enabled: false bypass via config
  const disabledResult = getRelevantContext(db, 'ok', { workspace: ws, recallGating: { enabled: false } });
  assert(disabledResult.gated !== true, 'recallGating.enabled=false should disable the gate');

  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
