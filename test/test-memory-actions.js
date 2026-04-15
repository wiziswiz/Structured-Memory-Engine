#!/usr/bin/env node
/**
 * Tests for lib/memory-actions.js — update/replace/forget/protect + resolveTarget.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const { openDb, insertChunks } = require('../lib/store');
const {
  executeAction, resolveTarget,
  AmbiguousTargetError, TargetNotFoundError,
} = require('../lib/memory-actions');
const { runReflectCycle, pruneStale } = require('../lib/reflect');

let passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  \u2717 ${msg}`); }
}

function tmpWs() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sme-actions-test-'));
  fs.mkdirSync(path.join(ws, '.memory'), { recursive: true });
  return ws;
}

console.log('Test 1: update — preserves id, updates content, re-extracts entities');
{
  const ws = tmpWs();
  const db = openDb(ws);
  insertChunks(db, 'memory/test.md', Date.now(), [
    { content: 'The redis cache TTL is 120 seconds mentioning @oldapp', heading: 'Cache', lineStart: 1, lineEnd: 1, entities: ['@oldapp'], chunkType: 'fact' },
  ], '2026-01-01T00:00:00.000Z');

  const before = db.prepare('SELECT * FROM chunks LIMIT 1').get();
  const result = executeAction(db, { action: 'update', target: before.id, content: 'Cache TTL is now 300 seconds @Nexus replaced @oldapp' });
  const after = db.prepare('SELECT * FROM chunks WHERE id = ?').get(before.id);

  assert(result.action === 'update', 'result.action=update');
  assert(after.id === before.id, `id preserved: ${after.id} === ${before.id}`);
  assert(after.created_at === before.created_at, 'created_at preserved');
  assert(after.content.includes('300 seconds'), `content updated, got "${after.content}"`);

  const entities = JSON.parse(after.entities);
  assert(entities.includes('@Nexus'), `update should re-extract @Nexus; got ${JSON.stringify(entities)}`);
  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log('Test 2: replace — archives old, creates new with fresh entities and priority');
{
  const ws = tmpWs();
  const db = openDb(ws);
  insertChunks(db, 'memory/test.md', Date.now(), [
    { content: 'Gateway runs on port 3000 @oldapp', heading: 'Gateway', lineStart: 1, lineEnd: 1, entities: ['@oldapp'], chunkType: 'fact' },
  ], '2026-01-01T00:00:00.000Z');

  const before = db.prepare('SELECT * FROM chunks LIMIT 1').get();
  const result = executeAction(db, { action: 'replace', target: before.id, content: 'Gateway runs on port 8080 @Echelon **ProjectX**' });

  const oldChunk = db.prepare('SELECT * FROM chunks WHERE id = ?').get(before.id);
  const newChunk = db.prepare('SELECT * FROM chunks WHERE id = ?').get(result.newId);

  assert(oldChunk.confidence === 0, `old chunk confidence zeroed: ${oldChunk.confidence}`);
  assert(oldChunk.superseded_by === result.newId, `superseded_by set: ${oldChunk.superseded_by} === ${result.newId}`);
  assert(oldChunk.archived_at != null, 'old chunk has archived_at');
  assert(newChunk != null, 'new chunk exists');
  assert(newChunk.content === 'Gateway runs on port 8080 @Echelon **ProjectX**', 'new chunk has new content');
  assert(newChunk.file_path === before.file_path, 'new chunk preserves file_path');
  assert(newChunk.id !== before.id, 'new id is different');

  const newEntities = JSON.parse(newChunk.entities);
  assert(newEntities.includes('@Echelon'), `replace should extract @Echelon; got ${JSON.stringify(newEntities)}`);
  assert(newEntities.includes('ProjectX'), `replace should extract ProjectX (bold); got ${JSON.stringify(newEntities)}`);
  assert(!newEntities.includes('@oldapp'), `replace should NOT carry forward old entities; got ${JSON.stringify(newEntities)}`);
  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log('Test 3: forget — soft-delete via confidence + archived_at');
{
  const ws = tmpWs();
  const db = openDb(ws);
  insertChunks(db, 'memory/test.md', Date.now(), [
    { content: 'Old fact that should be forgotten', heading: 'Old', lineStart: 1, lineEnd: 1, entities: [], chunkType: 'fact' },
  ], '2026-01-01T00:00:00.000Z');

  const before = db.prepare('SELECT * FROM chunks LIMIT 1').get();
  executeAction(db, { action: 'forget', target: before.id });
  const after = db.prepare('SELECT * FROM chunks WHERE id = ?').get(before.id);

  assert(after.confidence === 0, `confidence zeroed: ${after.confidence}`);
  assert(after.archived_at != null, 'archived_at set');
  assert(after.content === before.content, 'content preserved (soft delete)');
  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log('Test 4: protect — survives reflect decay cycle');
{
  const ws = tmpWs();
  const db = openDb(ws);
  insertChunks(db, 'memory/test.md', Date.now(), [
    { content: 'Protected fact about the project', heading: 'Facts', lineStart: 1, lineEnd: 1, entities: [], chunkType: 'fact' },
  ], '2024-01-01T00:00:00.000Z');

  // Backdate with a moderate confidence that would normally decay
  db.prepare("UPDATE chunks SET created_at = ?, last_accessed = ?, confidence = 0.5 WHERE id = 1")
    .run('2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');

  executeAction(db, { action: 'protect', target: 1 });
  const protectedChunk = db.prepare('SELECT * FROM chunks WHERE id = 1').get();
  assert(protectedChunk.protected === 1, `protected=1, got ${protectedChunk.protected}`);

  // Run reflect — protected chunk should not lose confidence
  runReflectCycle(db, { dryRun: false });
  const afterReflect = db.prepare('SELECT confidence, stale FROM chunks WHERE id = 1').get();
  assert(afterReflect.confidence === 0.5, `protected chunk confidence unchanged, got ${afterReflect.confidence}`);
  assert(afterReflect.stale === 0, `protected chunk not marked stale, got ${afterReflect.stale}`);
  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log('Test 5: protect prevents pruning');
{
  const ws = tmpWs();
  const db = openDb(ws);
  insertChunks(db, 'memory/test.md', Date.now(), [
    { content: 'important long-term fact', heading: null, lineStart: 1, lineEnd: 1, entities: [], chunkType: 'fact' },
  ], '2024-01-01T00:00:00.000Z');

  // Force a state that pruneStale would normally archive
  db.prepare('UPDATE chunks SET stale = 1, confidence = 0.01, created_at = ? WHERE id = 1')
    .run('2024-01-01T00:00:00.000Z');

  executeAction(db, { action: 'protect', target: 1 });

  const result = pruneStale(db);
  assert(result.archived === 0, `protected chunk not archived, got ${result.archived}`);
  const stillExists = db.prepare('SELECT id FROM chunks WHERE id = 1').get();
  assert(stillExists != null, 'protected chunk still in chunks table');
  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log('Test 6: resolveTarget — numeric id direct lookup');
{
  const ws = tmpWs();
  const db = openDb(ws);
  insertChunks(db, 'memory/test.md', Date.now(), [
    { content: 'chunk A', heading: null, lineStart: 1, lineEnd: 1, entities: [], chunkType: 'raw' },
    { content: 'chunk B', heading: null, lineStart: 2, lineEnd: 2, entities: [], chunkType: 'raw' },
  ], null);

  const row = resolveTarget(db, 1, { workspace: ws });
  assert(row.id === 1, `resolved id=1, got ${row.id}`);
  assert(row.content === 'chunk A', 'resolved correct content');

  // String numeric also works
  const row2 = resolveTarget(db, '2', { workspace: ws });
  assert(row2.id === 2, 'string numeric resolves');

  // Missing id throws TargetNotFoundError
  let threw = false;
  try { resolveTarget(db, 99999, { workspace: ws }); }
  catch (e) { threw = e instanceof TargetNotFoundError; }
  assert(threw, 'missing id throws TargetNotFoundError');
  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log('Test 7: resolveTarget — ambiguous query raises AmbiguousTargetError');
{
  const ws = tmpWs();
  const db = openDb(ws);
  // Two identical chunks — guaranteed ambiguous
  insertChunks(db, 'memory/v1.md', Date.now(), [
    { content: 'gateway listens on port 3000 in development', heading: null, lineStart: 1, lineEnd: 1, entities: [], chunkType: 'fact' },
  ], null);
  insertChunks(db, 'memory/v2.md', Date.now(), [
    { content: 'gateway listens on port 3000 in development', heading: null, lineStart: 1, lineEnd: 1, entities: [], chunkType: 'fact' },
  ], null);

  let err = null;
  try { resolveTarget(db, 'gateway port 3000 development', { workspace: ws }); }
  catch (e) { err = e; }
  // This is the core safety check — if the resolver silently picks one of
  // two identical chunks, it will corrupt the wrong chunk on a mutation.
  assert(err instanceof AmbiguousTargetError,
    `expected AmbiguousTargetError for identical-content collision, got ${err && err.name}: ${err && err.message}`);
  if (err instanceof AmbiguousTargetError) {
    assert(err.candidates.length >= 2, `candidates surfaced: ${err.candidates.length}`);
    assert(err.candidates[0].content.includes('gateway'), 'candidate content preserved');
    assert(err.candidates[0].score > 0, 'candidate has a score');
  }
  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log('Test 8: resolveTarget — off-topic query returns TargetNotFoundError');
{
  const ws = tmpWs();
  const db = openDb(ws);
  insertChunks(db, 'memory/x.md', Date.now(), [
    { content: 'completely unrelated fact about databases', heading: null, lineStart: 1, lineEnd: 1, entities: [], chunkType: 'fact' },
  ], null);

  let err = null;
  try { resolveTarget(db, 'quantum mechanics wavefunction collapse', { workspace: ws }); }
  catch (e) { err = e; }
  assert(err instanceof TargetNotFoundError,
    `expected TargetNotFoundError for off-topic query, got ${err && err.name}`);
  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log('Test 9: action errors — missing content on update/replace');
{
  const ws = tmpWs();
  const db = openDb(ws);
  insertChunks(db, 'memory/test.md', Date.now(), [
    { content: 'chunk', heading: null, lineStart: 1, lineEnd: 1, entities: [], chunkType: 'raw' },
  ], null);

  let threw = false;
  try { executeAction(db, { action: 'update', target: 1 }); }
  catch (_) { threw = true; }
  assert(threw, 'update without content throws');

  let threw2 = false;
  try { executeAction(db, { action: 'replace', target: 1 }); }
  catch (_) { threw2 = true; }
  assert(threw2, 'replace without content throws');
  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log('Test 10: protect does not prevent reinforcement (protect is about decay only)');
{
  const ws = tmpWs();
  const db = openDb(ws);
  insertChunks(db, 'memory/test.md', Date.now(), [
    { content: 'Important fact', heading: null, lineStart: 1, lineEnd: 1, entities: [], chunkType: 'fact' },
  ], null);
  db.prepare('UPDATE chunks SET confidence = 0.4, access_count = 10, protected = 1 WHERE id = 1').run();

  const { reinforceConfidence } = require('../lib/reflect');
  reinforceConfidence(db);
  const after = db.prepare('SELECT confidence FROM chunks WHERE id = 1').get();
  assert(after.confidence >= 0.4, `reinforcement can raise protected chunk confidence, got ${after.confidence}`);
  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
