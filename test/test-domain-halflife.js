'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { score, CIL_PROFILE, RECALL_PROFILE, DOMAIN_HALF_LIFE, getDomainHalfLife } = require('../lib/scoring');

const NOW = Date.now();
const FORTY_DAYS_AGO = new Date(NOW - 40 * 86400000).toISOString();
const THREE_DAYS_AGO = new Date(NOW - 3 * 86400000).toISOString();

function makeChunk(domain, createdAt) {
  return {
    confidence: 1.0,
    created_at: createdAt,
    chunk_type: 'fact',
    file_weight: 1.0,
    domain,
    _normalizedFts: 0.5,
    _entityMatch: false,
  };
}

test('getDomainHalfLife — returns domain-specific half-life for short profiles', () => {
  assert.strictEqual(getDomainHalfLife('health', 14), 90);
  assert.strictEqual(getDomainHalfLife('personal', 14), 90);
  assert.strictEqual(getDomainHalfLife('crypto', 14), 14);
  assert.strictEqual(getDomainHalfLife('work', 14), 60);
  assert.strictEqual(getDomainHalfLife('finance', 14), 30);
  assert.strictEqual(getDomainHalfLife('general', 14), 30);
});

test('getDomainHalfLife — does not override long half-life profiles', () => {
  // Recall profile has 90d half-life — domain override would be a downgrade for health
  assert.strictEqual(getDomainHalfLife('health', 90), 90);
  assert.strictEqual(getDomainHalfLife('crypto', 90), 90);
  assert.strictEqual(getDomainHalfLife('work', 90), 90);
  // Assistant profile at 30d — should NOT be overridden
  assert.strictEqual(getDomainHalfLife('health', 30), 30);
});

test('getDomainHalfLife — threshold is >14d (CIL-style only)', () => {
  assert.strictEqual(getDomainHalfLife('health', 14), 90); // exactly 14 — overrides (CIL)
  assert.strictEqual(getDomainHalfLife('health', 15), 15); // above threshold — no override
  assert.strictEqual(getDomainHalfLife('health', 10), 90); // below threshold — override
});

test('getDomainHalfLife — custom overrides', () => {
  const custom = { health: 120, crypto: 7 };
  assert.strictEqual(getDomainHalfLife('health', 14, custom), 120);
  assert.strictEqual(getDomainHalfLife('crypto', 14, custom), 7);
});

test('CIL profile: health chunk at 40 days scores higher than with flat 14d half-life', () => {
  const healthChunk = makeChunk('health', FORTY_DAYS_AGO);
  const cryptoChunk = makeChunk('crypto', FORTY_DAYS_AGO);

  const healthScore = score(healthChunk, NOW, CIL_PROFILE);
  const cryptoScore = score(cryptoChunk, NOW, CIL_PROFILE);

  // Health should score significantly higher due to 90d half-life vs crypto's 14d
  assert.ok(healthScore > cryptoScore * 1.5,
    `Health (${healthScore.toFixed(4)}) should be >1.5x crypto (${cryptoScore.toFixed(4)}) at 40 days`);
});

test('CIL profile: recent chunks unaffected (both domains score similarly)', () => {
  const healthChunk = makeChunk('health', THREE_DAYS_AGO);
  const cryptoChunk = makeChunk('crypto', THREE_DAYS_AGO);

  const healthScore = score(healthChunk, NOW, CIL_PROFILE);
  const cryptoScore = score(cryptoChunk, NOW, CIL_PROFILE);

  // Both should be similar for recent chunks (within 30%)
  const ratio = healthScore / cryptoScore;
  assert.ok(ratio > 0.7 && ratio < 1.3,
    `Recent chunks should score similarly: health=${healthScore.toFixed(4)} crypto=${cryptoScore.toFixed(4)}`);
});

test('RECALL profile: domain has no effect (half-life > 30)', () => {
  const healthChunk = makeChunk('health', FORTY_DAYS_AGO);
  const generalChunk = makeChunk('general', FORTY_DAYS_AGO);

  const healthScore = score(healthChunk, NOW, RECALL_PROFILE);
  const generalScore = score(generalChunk, NOW, RECALL_PROFILE);

  // Should be identical since recall profile has 90d half-life — no domain override
  assert.strictEqual(healthScore, generalScore);
});

test('DOMAIN_HALF_LIFE map has expected domains', () => {
  assert.ok(DOMAIN_HALF_LIFE.health > 0);
  assert.ok(DOMAIN_HALF_LIFE.personal > 0);
  assert.ok(DOMAIN_HALF_LIFE.crypto > 0);
  assert.ok(DOMAIN_HALF_LIFE.work > 0);
  assert.ok(DOMAIN_HALF_LIFE.finance > 0);
  assert.ok(DOMAIN_HALF_LIFE.general > 0);
});
