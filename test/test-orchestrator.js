#!/usr/bin/env node
/**
 * Tests for lib/orchestrator.js — recall strategy classification + profile
 * registration + live A/B regression against default (round-1 audit lesson).
 */
const { classifyStrategy, STRATEGY_PATTERNS, DEFAULT_STRATEGY } = require('../lib/orchestrator');
const { PROFILES, resolveProfile, RECALL_PROFILE } = require('../lib/scoring');

let passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  \u2717 ${msg}`); }
}

console.log('Test 1: entity_brief — "who is X" with detected entities');
{
  const r = classifyStrategy('who is Sarah Chen?', ['sarah chen']);
  assert(r.strategy === 'entity_brief', `Expected entity_brief, got ${r.strategy}`);
  assert(r.profile === 'entity_brief', `Expected profile entity_brief, got ${r.profile}`);

  const r2 = classifyStrategy('tell me about Movement Labs', ['movement labs']);
  assert(r2.strategy === 'entity_brief', `Expected entity_brief for "tell me about", got ${r2.strategy}`);

  const r3 = classifyStrategy('describe the auth middleware', ['auth middleware']);
  assert(r3.strategy === 'entity_brief', `Expected entity_brief for "describe", got ${r3.strategy}`);
}

console.log('Test 2: entity_brief requires detected entities');
{
  const r = classifyStrategy('who is the best dev', []);
  assert(r.strategy !== 'entity_brief',
    `Without entities, "who is..." should not classify as entity_brief, got ${r.strategy}`);
  assert(r.strategy === 'quick_context', `Expected quick_context fallback, got ${r.strategy}`);
}

console.log('Test 3: timeline_brief — date/month/year language');
{
  const cases = [
    'what happened in March 2026?',
    'what did I do last week',
    'notes from yesterday',
    'anything on 2026-03-15',
    'remember last month',
  ];
  for (const q of cases) {
    const r = classifyStrategy(q, []);
    assert(r.strategy === 'timeline_brief', `Expected timeline_brief for "${q}", got ${r.strategy}`);
  }
}

console.log('Test 4: relationship_brief — collaboration language (priority over entity_brief)');
{
  const r = classifyStrategy('how does Jake work with the design team', ['jake']);
  assert(r.strategy === 'relationship_brief', `Expected relationship_brief, got ${r.strategy}`);

  // "who is Sarah's manager" — has "who is" (entity_brief pattern) but
  // relationship_brief is checked first, so it wins.
  const r2 = classifyStrategy("who is Sarah's manager", ['sarah']);
  assert(r2.strategy === 'relationship_brief', `Expected relationship_brief for "manager", got ${r2.strategy}`);

  // No entities → should not match relationship_brief (requireEntities: true)
  const r3 = classifyStrategy('what does the team collaborate on', []);
  assert(r3.strategy !== 'relationship_brief',
    `Without entities, team/collaborate should NOT be relationship_brief, got ${r3.strategy}`);
}

console.log('Test 5: verification_lookup — source/citation language');
{
  const cases = [
    'where is this written',
    'what is the source of this claim',
    'which file has the API key',
    'exact date Movement Labs shipped',
    'verbatim quote from the meeting',
  ];
  for (const q of cases) {
    const r = classifyStrategy(q, []);
    assert(r.strategy === 'verification_lookup',
      `Expected verification_lookup for "${q}", got ${r.strategy}`);
  }
}

console.log('Test 6: quick_context fallback');
{
  const cases = [
    'make me a sandwich',
    'the quick brown fox',
    'arbitrary text with no patterns',
  ];
  for (const q of cases) {
    const r = classifyStrategy(q, []);
    assert(r.strategy === 'quick_context', `Expected quick_context for "${q}", got ${r.strategy}`);
    assert(r.profile === null, `quick_context should have null profile, got ${r.profile}`);
  }
}

console.log('Test 7: edge cases — invalid inputs');
{
  assert(classifyStrategy(null, []).strategy === 'quick_context', 'null query should default');
  assert(classifyStrategy(undefined, []).strategy === 'quick_context', 'undefined query should default');
  assert(classifyStrategy('', []).strategy === 'quick_context', 'empty query should default');
  assert(classifyStrategy(42, []).strategy === 'quick_context', 'non-string should default');
}

console.log('Test 8: all strategy profiles are registered in scoring.PROFILES');
{
  for (const [name, cfg] of Object.entries(STRATEGY_PATTERNS)) {
    assert(PROFILES[cfg.profile] != null, `Profile "${cfg.profile}" for strategy "${name}" missing from PROFILES`);
    const semKey = `${cfg.profile}-semantic`;
    assert(PROFILES[semKey] != null, `Semantic variant "${semKey}" missing from PROFILES`);
  }
  assert(PROFILES['quick_context'] != null, 'quick_context alias missing from PROFILES');
}

console.log('Test 9: strategy profiles are additive — base weights match default');
{
  // Round-1 audit lesson: strategy profiles must preserve the default's fts
  // and recency weights. Rebalancing them causes silent regression.
  const strategies = ['entity_brief', 'timeline_brief', 'relationship_brief', 'verification_lookup'];
  for (const name of strategies) {
    const p = resolveProfile(name, false);
    assert(p.fts === RECALL_PROFILE.fts,
      `${name} must preserve fts weight (${RECALL_PROFILE.fts}), got ${p.fts}`);
    assert(p.recency === RECALL_PROFILE.recency,
      `${name} must preserve recency weight (${RECALL_PROFILE.recency}), got ${p.recency}`);
    assert(p.type === RECALL_PROFILE.type,
      `${name} must preserve type weight, got ${p.type}`);
    assert(p.entity === RECALL_PROFILE.entity,
      `${name} must preserve entity weight, got ${p.entity}`);
  }

  // Each strategy has its own knob
  assert(resolveProfile('entity_brief', false).entityMention > 0,
    'entity_brief should have entityMention > 0 (its knob)');
  assert(resolveProfile('relationship_brief', false).entityMention > 0,
    'relationship_brief should have entityMention > 0 (its knob)');
  assert(resolveProfile('timeline_brief', false).recencyHalfLifeDays <= 60,
    'timeline_brief should have short recency halfLife (its knob)');
  assert(resolveProfile('verification_lookup', false).confidenceExponent > 1.0,
    'verification_lookup should have elevated confidenceExponent (its knob)');
  assert(resolveProfile('verification_lookup', false).recencyHalfLifeDays >= 180,
    'verification_lookup should have long recency halfLife (its knob)');
}

console.log('Test 10: integration — recall() uses orchestrator classified profile');
{
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { openDb, insertChunks } = require('../lib/store');
  const { recall } = require('../lib/recall');
  const { buildEntityIndex } = require('../lib/entities');

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sme-orchestrator-test-'));
  fs.mkdirSync(path.join(ws, '.memory'), { recursive: true });
  const db = openDb(ws);

  insertChunks(db, 'memory/test.md', Date.now(), [
    { content: 'Sarah Chen leads the Movement Labs team', heading: 'Test', lineStart: 1, lineEnd: 1, entities: ['sarah chen', 'movement labs'], chunkType: 'fact' },
  ], null);
  buildEntityIndex(db);

  // Explicit profile — orchestrator should NOT override it
  const explicitRes = recall(db, 'who is Sarah Chen?', { recallProfile: 'default', explain: true });
  assert(explicitRes.explain.profile === 'default',
    `Explicit recallProfile should win, got ${explicitRes.explain.profile}`);

  // No explicit profile, query matches entity_brief pattern + has entity
  const classifiedRes = recall(db, 'who is Sarah Chen?', { explain: true });
  assert(classifiedRes.explain.strategy === 'entity_brief',
    `Expected entity_brief classification, got ${classifiedRes.explain.strategy}`);
  assert(classifiedRes.explain.profile === 'entity_brief',
    `Expected entity_brief profile, got ${classifiedRes.explain.profile}`);

  // orchestrator: false disables classification
  const disabledRes = recall(db, 'who is Sarah Chen?', { orchestrator: false, explain: true });
  assert(disabledRes.explain.strategy === 'quick_context',
    `orchestrator: false should yield quick_context, got ${disabledRes.explain.strategy}`);

  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log('Test 11: A/B regression — entity_brief must not score LOWER than default');
{
  // Round-1 audit: the original strategy profiles scored 42% LOWER than
  // default on entity queries. The additive redesign must prevent this.
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { openDb, insertChunks } = require('../lib/store');
  const { recall } = require('../lib/recall');
  const { buildEntityIndex } = require('../lib/entities');

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sme-ab-test-'));
  fs.mkdirSync(path.join(ws, '.memory'), { recursive: true });
  const db = openDb(ws);

  // Seed a corpus with multiple sarah mentions so mention_count grows
  const chunks = [];
  for (let i = 0; i < 10; i++) chunks.push({
    content: `sarah is leading the quarterly planning ${i}`,
    heading: 'Sarah', lineStart: i, lineEnd: i, entities: ['sarah'], chunkType: 'raw',
  });
  insertChunks(db, 'memory/people.md', Date.now(), chunks, null);
  buildEntityIndex(db);

  const defaultR = recall(db, 'tell me about sarah', { limit: 1, workspace: ws, recallProfile: 'default' });
  const entityR = recall(db, 'tell me about sarah', { limit: 1, workspace: ws, recallProfile: 'entity_brief' });
  assert(entityR.length > 0, 'entity_brief should return results');
  assert(defaultR.length > 0, 'default should return results');
  if (entityR.length > 0 && defaultR.length > 0) {
    assert(entityR[0].finalScore >= defaultR[0].finalScore,
      `entity_brief (${entityR[0].finalScore.toFixed(4)}) should >= default (${defaultR[0].finalScore.toFixed(4)}) on entity queries`);
  }

  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
