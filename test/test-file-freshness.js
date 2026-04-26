'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../lib/store');
const { checkFileFreshness } = require('../lib/reflect');
const os = require('os');
const path = require('path');
const fs = require('fs');

function setupDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sme-freshness-'));
  const db = openDb(tmpDir);
  return { db, tmpDir };
}

function insertFile(db, filePath, daysOld) {
  const mtimeMs = Date.now() - daysOld * 86400000;
  db.prepare('INSERT OR REPLACE INTO files (file_path, mtime_ms, chunk_count, indexed_at) VALUES (?, ?, ?, ?)').run(
    filePath, mtimeMs, 5, new Date().toISOString()
  );
}

test('checkFileFreshness — detects stale files beyond threshold', () => {
  const { db } = setupDb();
  insertFile(db, 'health.md', 41);  // 41 days old
  insertFile(db, 'trading.md', 3);  // 3 days old — fresh

  const result = checkFileFreshness(db, { config: { reflect: { freshnessAlertDays: 14 } } });

  assert.strictEqual(result.staleFiles.length, 1);
  assert.strictEqual(result.staleFiles[0].filePath, 'health.md');
  assert.ok(result.staleFiles[0].daysStale >= 40);
  db.close();
});

test('checkFileFreshness — no stale files when all fresh', () => {
  const { db } = setupDb();
  insertFile(db, 'health.md', 2);
  insertFile(db, 'trading.md', 5);

  const result = checkFileFreshness(db);
  assert.strictEqual(result.staleFiles.length, 0);
  db.close();
});

test('checkFileFreshness — respects custom alertDays', () => {
  const { db } = setupDb();
  insertFile(db, 'health.md', 10);

  // Default 14d — should be fresh
  let result = checkFileFreshness(db);
  assert.strictEqual(result.staleFiles.length, 0);

  // Custom 7d — should be stale
  result = checkFileFreshness(db, { config: { reflect: { freshnessAlertDays: 7 } } });
  assert.strictEqual(result.staleFiles.length, 1);
  db.close();
});

test('checkFileFreshness — sorted by staleness descending', () => {
  const { db } = setupDb();
  insertFile(db, 'a.md', 20);
  insertFile(db, 'b.md', 50);
  insertFile(db, 'c.md', 30);

  const result = checkFileFreshness(db);
  assert.strictEqual(result.staleFiles[0].filePath, 'b.md');
  assert.strictEqual(result.staleFiles[1].filePath, 'c.md');
  assert.strictEqual(result.staleFiles[2].filePath, 'a.md');
  db.close();
});

test('checkFileFreshness — returns alertDays in result', () => {
  const { db } = setupDb();
  const result = checkFileFreshness(db, { config: { reflect: { freshnessAlertDays: 21 } } });
  assert.strictEqual(result.alertDays, 21);
  db.close();
});

test('checkFileFreshness — defaults to 14 days when no config', () => {
  const { db } = setupDb();
  const result = checkFileFreshness(db);
  assert.strictEqual(result.alertDays, 14);
  db.close();
});
