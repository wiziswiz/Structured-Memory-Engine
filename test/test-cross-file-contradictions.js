'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../lib/store');
const { detectCrossFileContradictions } = require('../lib/reflect');
const os = require('os');
const path = require('path');
const fs = require('fs');

function setupDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sme-crossfile-'));
  const db = openDb(tmpDir);
  // Create entity_index table
  db.exec(`CREATE TABLE IF NOT EXISTS entity_index (
    id INTEGER PRIMARY KEY,
    entity TEXT UNIQUE,
    mention_count INTEGER,
    chunk_ids TEXT,
    co_entities TEXT,
    last_seen TEXT
  )`);
  return { db, tmpDir };
}

function insertChunk(db, id, filePath, content, entities, domain) {
  db.prepare(`INSERT INTO chunks (id, file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, domain)
    VALUES (?, ?, ?, ?, 1, 5, ?, 'fact', 1.0, ?, ?, ?)`).run(
    id, filePath, 'Status', content, JSON.stringify(entities), new Date().toISOString(), new Date().toISOString(), domain || 'health'
  );
}

function insertEntity(db, entity, chunkIds) {
  db.prepare('INSERT INTO entity_index (entity, mention_count, chunk_ids, co_entities, last_seen) VALUES (?, ?, ?, ?, ?)').run(
    entity, chunkIds.length, JSON.stringify(chunkIds), '{}', new Date().toISOString()
  );
}

test('detectCrossFileContradictions — catches contradiction across different files', () => {
  const { db } = setupDb();

  insertChunk(db, 1, 'health.md', 'Bromantane active Day 8 — dopamine support via COMT pathway modulation', ['bromantane'], 'health');
  insertChunk(db, 2, 'MEMORY.md', 'Bromantane PAUSED — stopped taking bromantane, on break from dopamine support', ['bromantane'], 'health');

  insertEntity(db, 'bromantane', [1, 2]);

  const result = detectCrossFileContradictions(db);

  assert.strictEqual(result.newFlags, 1, 'Should detect 1 cross-file contradiction');
  assert.ok(result.details[0].reason.includes('Cross-file'), 'Reason should mention cross-file');
  assert.ok(result.details[0].reason.includes('bromantane'), 'Reason should mention the entity');
  db.close();
});

test('detectCrossFileContradictions — ignores same-file pairs', () => {
  const { db } = setupDb();

  // Both in same file — heading-based detector handles this
  insertChunk(db, 1, 'health.md', 'Bromantane active Day 8 dopamine support', ['bromantane'], 'health');
  insertChunk(db, 2, 'health.md', 'Bromantane stopped discontinued dopamine', ['bromantane'], 'health');

  insertEntity(db, 'bromantane', [1, 2]);

  const result = detectCrossFileContradictions(db);
  assert.strictEqual(result.newFlags, 0, 'Same-file pairs should be skipped');
  db.close();
});

test('detectCrossFileContradictions — requires negation pattern', () => {
  const { db } = setupDb();

  insertChunk(db, 1, 'health.md', 'Bromantane protocol for dopamine support via COMT modulation enhancement', ['bromantane'], 'health');
  insertChunk(db, 2, 'MEMORY.md', 'Bromantane dosage adjusted for dopamine support optimization schedule', ['bromantane'], 'health');

  insertEntity(db, 'bromantane', [1, 2]);

  const result = detectCrossFileContradictions(db);
  assert.strictEqual(result.newFlags, 0, 'No negation pattern — should not flag');
  db.close();
});

test('detectCrossFileContradictions — respects domain gate', () => {
  const { db } = setupDb();

  insertChunk(db, 1, 'health.md', 'Protocol active and running daily dosage support', ['protocol'], 'health');
  insertChunk(db, 2, 'trading.md', 'Protocol not active, removed from portfolio, stopped trading', ['protocol'], 'crypto');

  insertEntity(db, 'protocol', [1, 2]);

  const result = detectCrossFileContradictions(db);
  assert.strictEqual(result.newFlags, 0, 'Cross-domain pairs should be skipped');
  db.close();
});

test('detectCrossFileContradictions — skips already-existing contradictions', () => {
  const { db } = setupDb();

  insertChunk(db, 1, 'health.md', 'Bromantane active Day 8 dopamine support COMT pathway', ['bromantane'], 'health');
  insertChunk(db, 2, 'MEMORY.md', 'Bromantane stopped not taking anymore dopamine break', ['bromantane'], 'health');

  // Pre-existing contradiction
  db.prepare('INSERT INTO contradictions (chunk_id_old, chunk_id_new, reason, created_at) VALUES (?, ?, ?, ?)').run(
    1, 2, 'existing', new Date().toISOString()
  );

  insertEntity(db, 'bromantane', [1, 2]);

  const result = detectCrossFileContradictions(db);
  assert.strictEqual(result.newFlags, 0, 'Should skip already-flagged pairs');
  db.close();
});

test('detectCrossFileContradictions — skips stale chunks', () => {
  const { db } = setupDb();

  insertChunk(db, 1, 'health.md', 'Bromantane active Day 8 dopamine support COMT pathway', ['bromantane'], 'health');
  // Mark chunk 2 as stale
  db.prepare(`INSERT INTO chunks (id, file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, domain, stale)
    VALUES (?, ?, ?, ?, 1, 5, ?, 'fact', 0.1, ?, ?, ?, 1)`).run(
    2, 'MEMORY.md', 'Status', 'Bromantane stopped not taking dopamine break discontinued', JSON.stringify(['bromantane']),
    new Date().toISOString(), new Date().toISOString(), 'health'
  );

  insertEntity(db, 'bromantane', [1, 2]);

  const result = detectCrossFileContradictions(db);
  assert.strictEqual(result.newFlags, 0, 'Should skip stale chunks');
  db.close();
});

test('detectCrossFileContradictions — dry run does not insert', () => {
  const { db } = setupDb();

  insertChunk(db, 1, 'health.md', 'Bromantane active Day 8 — dopamine support via COMT pathway modulation', ['bromantane'], 'health');
  insertChunk(db, 2, 'MEMORY.md', 'Bromantane stopped — no longer taking bromantane, on break from dopamine support', ['bromantane'], 'health');

  insertEntity(db, 'bromantane', [1, 2]);

  const result = detectCrossFileContradictions(db, { dryRun: true });
  assert.strictEqual(result.newFlags, 1, 'Should detect contradiction');

  const count = db.prepare('SELECT COUNT(*) as n FROM contradictions').get().n;
  assert.strictEqual(count, 0, 'Dry run should not insert into contradictions table');
  db.close();
});

test('detectCrossFileContradictions — requires minimum shared terms', () => {
  const { db } = setupDb();

  // Very different content, only entity in common
  insertChunk(db, 1, 'health.md', 'Bromantane supplement protocol for morning routine', ['bromantane'], 'health');
  insertChunk(db, 2, 'MEMORY.md', 'Bromantane not available at pharmacy discontinued vendor', ['bromantane'], 'health');

  insertEntity(db, 'bromantane', [1, 2]);

  // With high minSharedTerms, should not flag
  const result = detectCrossFileContradictions(db, { config: { reflect: { contradictionMinSharedTerms: 10 } } });
  assert.strictEqual(result.newFlags, 0, 'Insufficient shared terms should not flag');
  db.close();
});
