'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { formatContext } = require('../lib/context');

function makeChunk(id, daysOld, opts = {}) {
  const date = new Date(Date.now() - daysOld * 86400000).toISOString();
  return {
    id,
    content: opts.content || `Test content for chunk ${id}`,
    filePath: opts.filePath || `memory/test-${id}.md`,
    lineStart: 1,
    lineEnd: 5,
    heading: opts.heading || null,
    confidence: opts.confidence || 1.0,
    chunkType: opts.chunkType || 'fact',
    entities: [],
    date,
    cilScore: opts.cilScore || 0.5,
  };
}

test('formatContext — adds staleness warning for chunks >30 days old', () => {
  const chunks = [makeChunk(1, 45)]; // 45 days old
  const text = formatContext(chunks, []);

  assert.ok(text.includes('⏳'), 'Should contain staleness emoji');
  assert.ok(text.includes('verify before acting'), 'Should contain verify warning');
  assert.match(text, /⏳ \d+d ago/, 'Should show days count');
});

test('formatContext — no staleness warning for recent chunks', () => {
  const chunks = [makeChunk(1, 5)]; // 5 days old
  const text = formatContext(chunks, []);

  assert.ok(!text.includes('⏳'), 'Should NOT contain staleness emoji for recent chunks');
  assert.ok(!text.includes('verify before acting'), 'Should NOT contain verify warning');
});

test('formatContext — staleness at exactly 30 days', () => {
  const chunks = [makeChunk(1, 30)]; // exactly 30 days
  const text = formatContext(chunks, []);

  assert.ok(text.includes('⏳'), 'Should warn at exactly threshold');
});

test('formatContext — custom staleness threshold', () => {
  const chunks = [makeChunk(1, 20)]; // 20 days old

  // Default 30d threshold — no warning
  let text = formatContext(chunks, []);
  assert.ok(!text.includes('⏳'), 'Should NOT warn at 20d with default 30d threshold');

  // Custom 14d threshold — should warn
  text = formatContext(chunks, [], { stalenessWarningDays: 14 });
  assert.ok(text.includes('⏳'), 'Should warn at 20d with 14d threshold');
});

test('formatContext — staleness warning on secondary (collapsed) chunks too', () => {
  const chunks = [
    makeChunk(1, 5, { filePath: 'test.md' }),   // recent, same file
    makeChunk(2, 45, { filePath: 'test.md' }),   // old, same file — collapsed
  ];
  const text = formatContext(chunks, []);

  // The collapsed chunk should also have staleness warning
  assert.ok(text.includes('⏳'), 'Collapsed old chunk should have staleness warning');
});

test('formatContext — no date means no staleness label', () => {
  const chunk = makeChunk(1, 0);
  chunk.date = null;  // no date
  const text = formatContext([chunk], []);

  assert.ok(!text.includes('⏳'), 'No date should mean no staleness warning');
});

test('formatContext — empty chunks returns empty string', () => {
  const text = formatContext([], []);
  assert.strictEqual(text, '');
});
