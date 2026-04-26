'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { enforceDomainDiversity } = require('../lib/context');

function makeChunk(id, domain, score) {
  return { id, domain, _cilScore: score, content: `chunk ${id}`, file_path: `file-${id}.md` };
}

test('enforceDomainDiversity — injects missing domain chunk', () => {
  // 5 crypto chunks at top, 1 health chunk buried at position 6
  const results = [
    makeChunk(1, 'crypto', 0.9),
    makeChunk(2, 'crypto', 0.85),
    makeChunk(3, 'crypto', 0.8),
    makeChunk(4, 'crypto', 0.75),
    makeChunk(5, 'crypto', 0.7),
    makeChunk(6, 'health', 0.5),  // buried below maxChunks
  ];

  const reordered = enforceDomainDiversity(results, 5);
  // Function returns full array; caller does slice(0, maxChunks)
  const selected = reordered.slice(0, 5);

  assert.strictEqual(selected.length, 5);
  const domains = new Set(selected.map(c => c.domain));
  assert.ok(domains.has('health'), 'health domain should be represented');
  assert.ok(domains.has('crypto'), 'crypto domain should still be represented');

  // Health chunk should have displaced the lowest crypto chunk
  const healthChunk = selected.find(c => c.domain === 'health');
  assert.strictEqual(healthChunk.id, 6);
});

test('enforceDomainDiversity — no-op when all domains already represented', () => {
  const results = [
    makeChunk(1, 'crypto', 0.9),
    makeChunk(2, 'health', 0.85),
    makeChunk(3, 'work', 0.8),
  ];

  const selected = enforceDomainDiversity(results, 5);
  assert.strictEqual(selected.length, 3);
  assert.deepStrictEqual(selected.map(c => c.id), [1, 2, 3]);
});

test('enforceDomainDiversity — does not inject general domain', () => {
  // 4 crypto chunks fill top-3, general is in pool — should NOT be force-injected
  const results = [
    makeChunk(1, 'crypto', 0.9),
    makeChunk(2, 'crypto', 0.85),
    makeChunk(3, 'crypto', 0.8),
    makeChunk(4, 'general', 0.5),  // general should NOT be force-injected
  ];

  const selected = enforceDomainDiversity(results, 3);
  // Caller will slice(0, 3) afterward — top 3 should all be crypto
  const top3 = selected.slice(0, 3);
  assert.ok(top3.every(c => c.domain === 'crypto'), 'General should not displace crypto');
});

test('enforceDomainDiversity — handles multiple missing domains', () => {
  const results = [
    makeChunk(1, 'crypto', 0.9),
    makeChunk(2, 'crypto', 0.85),
    makeChunk(3, 'crypto', 0.8),
    makeChunk(4, 'crypto', 0.75),
    makeChunk(5, 'health', 0.5),
    makeChunk(6, 'work', 0.45),
  ];

  const selected = enforceDomainDiversity(results, 4);
  const domains = new Set(selected.map(c => c.domain));
  assert.ok(domains.has('health'), 'health should be injected');
  assert.ok(domains.has('work'), 'work should be injected');
  assert.ok(domains.has('crypto'), 'crypto should remain');
});

test('enforceDomainDiversity — single chunk returns unchanged', () => {
  const results = [makeChunk(1, 'crypto', 0.9)];
  const selected = enforceDomainDiversity(results, 5);
  assert.strictEqual(selected.length, 1);
});

test('enforceDomainDiversity — empty input returns empty', () => {
  const selected = enforceDomainDiversity([], 5);
  assert.strictEqual(selected.length, 0);
});

test('enforceDomainDiversity — null/undefined domain treated as general (not injected)', () => {
  const results = [
    makeChunk(1, 'crypto', 0.9),
    makeChunk(2, 'crypto', 0.85),
    makeChunk(3, 'crypto', 0.8),
    { id: 4, domain: null, _cilScore: 0.5, content: 'chunk 4', file_path: 'f4.md' },
    { id: 5, domain: undefined, _cilScore: 0.45, content: 'chunk 5', file_path: 'f5.md' },
  ];

  const reordered = enforceDomainDiversity(results, 3);
  const top3 = reordered.slice(0, 3);
  // null/undefined domains should NOT be force-injected (treated as general)
  assert.ok(top3.every(c => c.domain === 'crypto'), 'Null/undefined domains should not displace');
});

test('enforceDomainDiversity — displacement exhaustion (all top-N at 1 per domain)', () => {
  // Top 3 each have unique domains at count 1 — no over-represented domain to displace
  const results = [
    makeChunk(1, 'crypto', 0.9),
    makeChunk(2, 'work', 0.85),
    makeChunk(3, 'finance', 0.8),
    makeChunk(4, 'health', 0.5),  // wants to be injected but can't displace anyone
  ];

  const reordered = enforceDomainDiversity(results, 3);
  const top3 = reordered.slice(0, 3);
  // Health cannot displace — all domains at count 1
  const domains = top3.map(c => c.domain);
  assert.ok(!domains.includes('health'), 'Health should not be injected when no over-represented domain exists');
});

test('enforceDomainDiversity — results re-sorted by score after injection', () => {
  const results = [
    makeChunk(1, 'crypto', 0.9),
    makeChunk(2, 'crypto', 0.85),
    makeChunk(3, 'crypto', 0.3),
    makeChunk(4, 'health', 0.5),
  ];

  const selected = enforceDomainDiversity(results, 3);
  // After injecting health (0.5) displacing lowest crypto (0.3),
  // the top 3 should be sorted by score
  const top3 = selected.slice(0, 3);
  for (let i = 1; i < top3.length; i++) {
    assert.ok(top3[i - 1]._cilScore >= top3[i]._cilScore,
      `Score ordering violated at index ${i}`);
  }
  // Health chunk should be in top 3
  assert.ok(top3.some(c => c.domain === 'health'), 'Health should be in top 3');
});
