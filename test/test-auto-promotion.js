#!/usr/bin/env node
/**
 * Tests for v10 recall-stat auto-promotion (lib/recall.js::recordRecallStats).
 *
 * Writes to v9.1's `priority` column — no separate memory_tier column.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const { openDb, insertChunks } = require('../lib/store');
const { recall, checkPromotion, PROMOTION_RULES } = require('../lib/recall');

let passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  \u2717 ${msg}`); }
}

function tmpWs() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sme-autoprom-test-'));
  fs.mkdirSync(path.join(ws, '.memory'), { recursive: true });
  return ws;
}

console.log('Test 1: checkPromotion — thresholds');
{
  // low → medium requires 10 recalls + 5 unique queries
  assert(checkPromotion({ priority: 'low', recall_count: 9, unique_query_count: 5 }) === null,
    '9 recalls should not promote low');
  assert(checkPromotion({ priority: 'low', recall_count: 10, unique_query_count: 4 }) === null,
    '10 recalls + 4 unique should not promote low (unique threshold)');
  assert(checkPromotion({ priority: 'low', recall_count: 10, unique_query_count: 5 }) === 'medium',
    '10/5 should promote low → medium');

  // medium → high requires 5 recalls + 3 unique queries
  assert(checkPromotion({ priority: 'medium', recall_count: 4, unique_query_count: 3 }) === null,
    '4 recalls should not promote medium');
  assert(checkPromotion({ priority: 'medium', recall_count: 5, unique_query_count: 2 }) === null,
    '5/2 should not promote (unique threshold)');
  assert(checkPromotion({ priority: 'medium', recall_count: 5, unique_query_count: 3 }) === 'medium' ? false : true,
    '5/3 promotes medium → high (not to itself)');
  assert(checkPromotion({ priority: 'medium', recall_count: 5, unique_query_count: 3 }) === 'high',
    '5/3 should promote medium → high');

  // high never promotes further
  assert(checkPromotion({ priority: 'high', recall_count: 1000, unique_query_count: 100 }) === null,
    'high has no further promotion');

  // null / undefined safe
  assert(checkPromotion(null) === null, 'null chunk → null');
  assert(checkPromotion({}) === null, 'chunk without priority → null');
  assert(checkPromotion({ priority: 'unknown' }) === null, 'unknown priority → null');
}

console.log('Test 2: PROMOTION_RULES are exported and sensible');
{
  assert(Array.isArray(PROMOTION_RULES), 'PROMOTION_RULES is an array');
  assert(PROMOTION_RULES.length === 2, `2 rules (low→medium, medium→high), got ${PROMOTION_RULES.length}`);
  assert(PROMOTION_RULES[0].from === 'low' && PROMOTION_RULES[0].to === 'medium', 'first rule low → medium');
  assert(PROMOTION_RULES[1].from === 'medium' && PROMOTION_RULES[1].to === 'high', 'second rule medium → high');
  assert(PROMOTION_RULES[0].minRecall > PROMOTION_RULES[1].minRecall, 'low→medium has higher recall bar than medium→high');
}

console.log('Test 3: integration — recall across distinct queries promotes medium → high');
{
  const ws = tmpWs();
  const db = openDb(ws);
  insertChunks(db, 'memory/facts.md', Date.now(), [
    { content: 'the redis cache TTL is 120 seconds for sessions', heading: 'Cache', lineStart: 1, lineEnd: 1, entities: [], chunkType: 'raw' },
  ], null);
  db.prepare('UPDATE chunks SET priority = ? WHERE id = 1').run('medium');

  const initial = db.prepare('SELECT priority, recall_count, unique_query_count FROM chunks WHERE id = 1').get();
  assert(initial.priority === 'medium', `initial priority medium, got ${initial.priority}`);
  assert(initial.recall_count === 0, `initial recall_count 0, got ${initial.recall_count}`);

  // 5 distinct queries (threshold for medium→high)
  for (const q of ['redis cache', 'TTL sessions', 'cache ttl time', 'redis fun', 'session ttl']) {
    recall(db, q, { limit: 5, workspace: ws, orchestrator: false });
  }

  const after = db.prepare('SELECT priority, recall_count, unique_query_count FROM chunks WHERE id = 1').get();
  assert(after.recall_count === 5, `recall_count should be 5, got ${after.recall_count}`);
  assert(after.unique_query_count === 5, `unique_query_count should be 5, got ${after.unique_query_count}`);
  assert(after.priority === 'high', `expected promotion to high, got ${after.priority}`);

  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log('Test 4: repeated identical query does NOT increment unique_query_count');
{
  const ws = tmpWs();
  const db = openDb(ws);
  insertChunks(db, 'memory/facts.md', Date.now(), [
    { content: 'unique fact about the database layer', heading: 'DB', lineStart: 1, lineEnd: 1, entities: [], chunkType: 'raw' },
  ], null);

  // Run the same query 5 times
  for (let i = 0; i < 5; i++) {
    recall(db, 'database layer unique', { limit: 5, workspace: ws, orchestrator: false });
  }

  const row = db.prepare('SELECT recall_count, unique_query_count FROM chunks WHERE id = 1').get();
  assert(row.recall_count === 5, `recall_count should be 5, got ${row.recall_count}`);
  assert(row.unique_query_count === 1, `unique_query_count should stay at 1, got ${row.unique_query_count}`);

  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log('Test 5: recordStats: false suppresses stat tracking');
{
  const ws = tmpWs();
  const db = openDb(ws);
  insertChunks(db, 'memory/facts.md', Date.now(), [
    { content: 'another unique observation', heading: 'Obs', lineStart: 1, lineEnd: 1, entities: [], chunkType: 'raw' },
  ], null);

  for (let i = 0; i < 10; i++) {
    recall(db, `unique query ${i}`, { limit: 5, workspace: ws, recordStats: false, orchestrator: false });
  }

  const row = db.prepare('SELECT recall_count FROM chunks WHERE id = 1').get();
  assert(row.recall_count === 0, `recordStats: false should leave recall_count at 0, got ${row.recall_count}`);

  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log('Test 6: query_hash_seen caps at 50 entries');
{
  const ws = tmpWs();
  const db = openDb(ws);
  insertChunks(db, 'memory/facts.md', Date.now(), [
    { content: 'a fact that will be surfaced many times via many distinct queries', heading: 'Q', lineStart: 1, lineEnd: 1, entities: [], chunkType: 'raw' },
  ], null);

  // 60 distinct queries → array should cap at 50
  for (let i = 0; i < 60; i++) {
    recall(db, `fact surfaced many distinct queries iteration ${i}`, { limit: 5, workspace: ws, orchestrator: false });
  }

  const row = db.prepare('SELECT recall_count, unique_query_count, query_hash_seen FROM chunks WHERE id = 1').get();
  const seen = JSON.parse(row.query_hash_seen);
  assert(Array.isArray(seen), 'query_hash_seen is an array');
  assert(seen.length <= 50, `query_hash_seen capped at 50, got ${seen.length}`);
  // recall_count is the authoritative counter — should hit 60 regardless
  assert(row.recall_count === 60, `recall_count should be 60, got ${row.recall_count}`);

  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log('Test 7: recordRecallStats handles missing/null query_hash_seen gracefully');
{
  const ws = tmpWs();
  const db = openDb(ws);
  insertChunks(db, 'memory/facts.md', Date.now(), [
    { content: 'fact with null hash seen', heading: null, lineStart: 1, lineEnd: 1, entities: [], chunkType: 'raw' },
  ], null);
  // Force query_hash_seen to NULL (pre-migration state)
  db.prepare('UPDATE chunks SET query_hash_seen = NULL WHERE id = 1').run();

  // Should not throw
  let threw = false;
  try {
    recall(db, 'fact null hash', { limit: 5, workspace: ws, orchestrator: false });
  } catch (_) { threw = true; }
  assert(!threw, 'recordRecallStats should handle null query_hash_seen');

  const row = db.prepare('SELECT query_hash_seen FROM chunks WHERE id = 1').get();
  const seen = JSON.parse(row.query_hash_seen || '[]');
  assert(seen.length === 1, `seen should have 1 entry after recovery, got ${seen.length}`);

  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
