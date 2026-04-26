'use strict';

/**
 * Shared scoring module — single scorer, multiple weight profiles.
 * Used by both recall.js (sme_query) and context.js (sme_context).
 */

const { staleRelativePenalty } = require('./temporal-freshness');

const TYPE_BONUS = {
  confirmed: 0.25,
  decision: 0.20,
  preference: 0.18,
  fact: 0.12,
  opinion: 0.06,
  inferred: 0.0,
  outdated: -0.20,
  action_item: 0.15,
  raw: 0.0,
};

// Weight profiles — additive weights sum to 1.0 (excluding semantic when absent).
// file_weight is applied multiplicatively (not in this sum) — see score().
const RECALL_PROFILE = {
  fts: 0.55,
  recency: 0.25,
  type: 0.10,
  entity: 0.10,
  semantic: 0,
  temporal: 0.08,
  confidenceExponent: 1.0,
  recencyHalfLifeDays: 90,
};

const RECALL_SEMANTIC_PROFILE = {
  fts: 0.30,
  recency: 0.20,
  type: 0.10,
  entity: 0.10,
  semantic: 0.30,
  temporal: 0.08,
  confidenceExponent: 1.0,
  recencyHalfLifeDays: 90,
};

const CIL_PROFILE = {
  fts: 0.35,
  recency: 0.35,
  type: 0.20,
  entity: 0.10,
  semantic: 0,
  temporal: 0.08,
  confidenceExponent: 1.5,
  recencyHalfLifeDays: 14,
};

const CIL_SEMANTIC_PROFILE = {
  fts: 0.20,
  recency: 0.25,
  type: 0.10,
  entity: 0.10,
  semantic: 0.35,
  temporal: 0.08,
  confidenceExponent: 1.5,
  recencyHalfLifeDays: 14,
};

const ASSISTANT_PROFILE = {
  fts: 0.40,
  recency: 0.30,
  type: 0.15,
  entity: 0.15,
  semantic: 0,
  temporal: 0.08,
  confidenceExponent: 1.2,
  recencyHalfLifeDays: 30,
};

const ASSISTANT_SEMANTIC_PROFILE = {
  fts: 0.20,
  recency: 0.25,
  type: 0.10,
  entity: 0.10,
  semantic: 0.35,
  temporal: 0.08,
  confidenceExponent: 1.2,
  recencyHalfLifeDays: 30,
};

// ─── v10 F1 Orchestrator strategy profiles ───
//
// DESIGN RULE (hard-learned from round-1 audit): every strategy profile is
// the default profile PLUS one strategy-specific knob. Never cut fts or
// recency to "make room" for differentiating signals — earlier versions did
// this and scored 42% LOWER than default on their target queries because
// the new signals couldn't offset the lost fts contribution.
//
// Each strategy adds exactly one thing:
//   entity_brief       — entityMention weight (F5 signal surfaces high-mention entities)
//   relationship_brief — entityMention weight (co-occurrence bonus for "X with Y" patterns)
//   timeline_brief     — shorter recencyHalfLifeDays (45d vs 90d — demotes old chunks)
//   verification_lookup— higher confidenceExponent + longer halfLife (well-attested, aged ok)

const ENTITY_BRIEF_PROFILE = {
  fts: 0.55, recency: 0.25, type: 0.10, entity: 0.10,
  entityMention: 0.30, // strategy knob
  semantic: 0,
  temporal: 0.08,
  confidenceExponent: 1.0,
  recencyHalfLifeDays: 120,  // old facts about people stay relevant
};

const ENTITY_BRIEF_SEMANTIC_PROFILE = {
  fts: 0.30, recency: 0.20, type: 0.10, entity: 0.10,
  entityMention: 0.25,
  semantic: 0.30,
  temporal: 0.08,
  confidenceExponent: 1.0,
  recencyHalfLifeDays: 120,
};

const TIMELINE_BRIEF_PROFILE = {
  fts: 0.55, recency: 0.25, type: 0.10, entity: 0.10,
  semantic: 0,
  temporal: 0.08,
  confidenceExponent: 1.0,
  recencyHalfLifeDays: 45,   // strategy knob — half default
};

const TIMELINE_BRIEF_SEMANTIC_PROFILE = {
  fts: 0.30, recency: 0.20, type: 0.10, entity: 0.10,
  semantic: 0.30,
  temporal: 0.08,
  confidenceExponent: 1.0,
  recencyHalfLifeDays: 45,
};

const RELATIONSHIP_BRIEF_PROFILE = {
  fts: 0.55, recency: 0.25, type: 0.10, entity: 0.10,
  entityMention: 0.30, // strategy knob — co-occurrence bonus via entityMentionScore
  semantic: 0,
  temporal: 0.08,
  confidenceExponent: 1.0,
  recencyHalfLifeDays: 120,
};

const RELATIONSHIP_BRIEF_SEMANTIC_PROFILE = {
  fts: 0.30, recency: 0.20, type: 0.10, entity: 0.10,
  entityMention: 0.25,
  semantic: 0.30,
  temporal: 0.08,
  confidenceExponent: 1.0,
  recencyHalfLifeDays: 120,
};

const VERIFICATION_LOOKUP_PROFILE = {
  fts: 0.55, recency: 0.25, type: 0.10, entity: 0.10,
  semantic: 0,
  temporal: 0.08,
  confidenceExponent: 1.5,   // strategy knob — penalize low-confidence harder
  recencyHalfLifeDays: 180,  // strategy knob — citations don't stale
};

const VERIFICATION_LOOKUP_SEMANTIC_PROFILE = {
  fts: 0.30, recency: 0.20, type: 0.10, entity: 0.10,
  semantic: 0.30,
  temporal: 0.08,
  confidenceExponent: 1.5,
  recencyHalfLifeDays: 180,
};

// --- Domain-aware recency half-life (v10.1) ---
// Stable domains (health, personal) shouldn't decay as fast as volatile ones (crypto).
// Only applies when the profile's recencyHalfLifeDays is short (≤30) — i.e. CIL profiles.
// For recall profiles with 90d half-life, domain override would be a downgrade, so skip.
const DOMAIN_HALF_LIFE = {
  health: 90,
  personal: 90,
  work: 60,
  crypto: 14,
  finance: 30,
  general: 30,
};

function getDomainHalfLife(domain, profileHalfLife, domainHalfLifeOverrides) {
  // Only override when the profile uses aggressive recency (CIL-style, ≤14d).
  // Profiles with longer half-lives (RECALL at 90d, ASSISTANT at 30d) shouldn't
  // get domain overrides — their half-life is already appropriate.
  if (profileHalfLife > 14) return profileHalfLife;
  const map = domainHalfLifeOverrides || DOMAIN_HALF_LIFE;
  const domainHL = map[domain];
  if (domainHL != null) return domainHL;
  return profileHalfLife;
}

// --- Priority multiplier (v9: priority-weighted chunks) ---
const PRIORITY_MULTIPLIER = {
  high: 1.25,
  medium: 1.0,
  low: 0.75,
};

// --- Temporal relevance (v9: three-date temporal model) ---

/**
 * Compute temporal relevance for a chunk given query temporal features.
 * @param {object} chunk — must have referenced_date
 * @param {object} queryFeatures — { since, until } from resolveTemporalQuery
 * @returns {number} 0.0, 0.5, or 1.0
 */
function computeTemporalRelevance(chunk, queryFeatures) {
  if (!chunk.referenced_date || !queryFeatures) return 0.0;
  const { since, until } = queryFeatures;
  if (!since) return 0.0;

  const refDate = chunk.referenced_date;
  const sinceDate = since.split('T')[0];
  const untilDate = until ? until.split('T')[0] : null;

  // Exact match: referenced_date within query range
  if (refDate >= sinceDate && (!untilDate || refDate < untilDate)) return 1.0;

  // Near match: within 3 days of the range
  const refMs = new Date(refDate).getTime();
  const sinceMs = new Date(sinceDate).getTime();
  const untilMs = untilDate ? new Date(untilDate).getTime() : sinceMs + 86400000;
  const threeDaysMs = 3 * 86400000;

  if (refMs >= sinceMs - threeDaysMs && refMs <= untilMs + threeDaysMs) return 0.5;

  return 0.0;
}

// --- Operational noise penalty (Item 5) ---
const OPS_NOISE_RE = /\b(run:|script|cron|pipeline|phase\s+\d+|auto-indexed|worker|webhook|endpoint|API|config(?:uration)?|token|port\b|sub-agent|session started|compaction|heartbeat|spawned|restart|session_id|message_id|chat_id|user_id|conversation_id|lcm_session|telegram.*routing|routing_tag)/i;
const NOISE_EXEMPT_TYPES = new Set(['decision', 'preference', 'confirmed']);

function opsNoisePenalty(chunk, nowMs) {
  if (!chunk.content || !OPS_NOISE_RE.test(chunk.content)) return 1.0;
  if (NOISE_EXEMPT_TYPES.has(chunk.chunk_type)) return 1.0;

  const created = chunk.created_at ? new Date(chunk.created_at).getTime() : 0;
  const daysAgo = Math.max(0, (nowMs - created) / 86400000);

  if (daysAgo <= 1) return 1.0;
  if (daysAgo <= 3) return 0.7;
  if (daysAgo <= 7) return 0.4;
  return 0.2;
}

// --- Metadata density penalty (v9.1) ---
const KV_LINE = /^\s*[\w_-]+\s*[:=]\s*.+/;

function metadataDensityPenalty(chunk) {
  if (!chunk.content) return 1.0;
  const lines = chunk.content.split('\n').filter(l => l.trim());
  if (lines.length === 0) return 1.0;
  const kvLines = lines.filter(l => KV_LINE.test(l)).length;
  const ratio = kvLines / lines.length;
  if (ratio > 0.5) return 0.15;
  if (ratio > 0.3) return 0.5;
  return 1.0;
}

/**
 * Boost recent daily memory files dynamically based on age.
 * Uses Math.max so config-set weights aren't overridden if already higher.
 */
function getDynamicFileWeight(filePath, baseWeight, nowMs) {
  const dateMatch = filePath && filePath.match(/memory\/(\d{4}-\d{2}-\d{2})\.md$/);
  if (dateMatch) {
    const fileDate = new Date(dateMatch[1]).getTime();
    const daysAgo = (nowMs - fileDate) / 86400000;
    if (daysAgo <= 1) return Math.max(baseWeight, 1.8);
    if (daysAgo <= 3) return Math.max(baseWeight, 1.5);
    if (daysAgo <= 7) return Math.max(baseWeight, 1.2);
  }
  return baseWeight;
}

/**
 * Score a single chunk using a weighted additive model with multiplicative file weight.
 *
 * Additive signals (FTS, recency, type, entity, semantic) are summed with profile weights.
 * file_weight and confidence are applied multiplicatively — they scale the entire score,
 * so a 0.3x build-artifact penalty can't be overwhelmed by a strong FTS match.
 *
 * @param {object} chunk — must have: confidence, created_at, chunk_type, file_weight.
 *   Optional enrichments: _normalizedFts, _entityMatch, _semanticSim.
 * @param {number} nowMs — Date.now()
 * @param {object} profile — weight profile (RECALL_PROFILE, CIL_PROFILE, etc.)
 * @param {object} [overrides] — per-call overrides (e.g. { recencyHalfLifeDays: 60 })
 * @returns {number} composite score (higher = better)
 */
function score(chunk, nowMs, profile, overrides) {
  const p = overrides ? { ...profile, ...overrides } : profile;
  const confidence = chunk.confidence != null ? chunk.confidence : 1.0;

  // Recency — use freshest available timestamp (v8: content_updated_at support)
  const createdMs = chunk.created_at ? new Date(chunk.created_at).getTime() : 0;
  const updatedMs = chunk.content_updated_at ? new Date(chunk.content_updated_at).getTime() : 0;
  const accessedMs = chunk.last_accessed ? new Date(chunk.last_accessed).getTime() : 0;
  const effectiveMs = Math.max(createdMs, updatedMs, accessedMs);
  const daysAgo = Math.max(0, (nowMs - effectiveMs) / 86400000);
  // v10.1: domain-aware half-life — stable domains (health) decay slower than volatile (crypto)
  const effectiveHalfLife = getDomainHalfLife(chunk.domain, p.recencyHalfLifeDays, p.domainHalfLife);
  const recency = Math.exp(-0.693 * daysAgo / effectiveHalfLife);

  // Type priority
  const typeBonus = TYPE_BONUS[chunk.chunk_type] || 0;

  // File weight — applied multiplicatively (not in additive sum)
  // Dynamic boost for recent daily memory files
  const baseFileWeight = chunk.file_weight || 1.0;
  const fileWeight = getDynamicFileWeight(chunk.file_path, baseFileWeight, nowMs);

  // Entity match bonus
  const entityMatch = chunk._entityMatch ? 1 : 0;

  // Entity mention signal (v10 F5) — log-scaled mention_count boost + co-occurrence bonus.
  // Only fires when the profile sets entityMention > 0 AND the caller passed
  // queryEntities + entityIndexMap through overrides. Silently returns 0 for
  // all profiles that don't opt in — zero regression for v9.1 profiles.
  const entityMention = (p.entityMention > 0 && p.queryEntities && p.entityIndexMap)
    ? entityMentionScore(chunk, p.queryEntities, p.entityIndexMap)
    : 0;

  // Semantic similarity (0 when embeddings not available or not in profile)
  const semantic = chunk._semanticSim || 0;

  // Temporal relevance (v9: three-date model)
  // Only active when chunk has _temporalRelevance enrichment (set by caller for temporal queries)
  const temporalRelevance = chunk._temporalRelevance || 0;
  const temporalWeight = (p.temporal || 0) * (temporalRelevance > 0 ? 1 : 0);
  // When temporal is active, proportionally reduce fts+recency; when inactive, redistribute to fts
  const effectiveFts = temporalWeight > 0 ? p.fts - temporalWeight * 0.6 : p.fts;
  const effectiveRecency = temporalWeight > 0 ? p.recency - temporalWeight * 0.4 : p.recency;

  // Additive sum — shift weights when semantic signal is available
  const useSemantic = p.semantic > 0 && semantic > 0;
  const baseScore = useSemantic
    ? effectiveFts * (chunk._normalizedFts || 0) +
      p.semantic * semantic +
      effectiveRecency * recency +
      p.type * (typeBonus + 0.15) / 0.30 +
      p.entity * entityMatch +
      (p.entityMention || 0) * entityMention +
      temporalWeight * temporalRelevance
    : (effectiveFts + p.semantic) * (chunk._normalizedFts || 0) +
      effectiveRecency * recency +
      p.type * (typeBonus + 0.15) / 0.30 +
      p.entity * entityMatch +
      (p.entityMention || 0) * entityMention +
      temporalWeight * temporalRelevance;

  // Multiplicative penalties: stale relative dates + operational noise + metadata density
  const stalePenalty = staleRelativePenalty(chunk);
  const noisePenalty = opsNoisePenalty(chunk, nowMs);
  const metaPenalty = metadataDensityPenalty(chunk);

  // Value scoring multiplier (v8: wire value_score into live recall)
  const vs = chunk.value_score;
  const valueScoringEnabled = p.valueScoringEnabled !== false;
  const valueMultiplier = (valueScoringEnabled && vs != null) ? (0.7 + vs * 0.6) : 1.0;
  // Maps: value_score 0→0.7x, 0.5→1.0x, 1.0→1.3x

  // Synonym-only match penalty (v8)
  const synonymPenalty = chunk._synonymMatch ? (p.synonymPenalty || 0.85) : 1.0;

  // Priority multiplier (v9)
  const priorityMult = PRIORITY_MULTIPLIER[chunk.priority] || 1.0;

  return baseScore * Math.pow(confidence, p.confidenceExponent) * fileWeight * stalePenalty * noisePenalty * metaPenalty * valueMultiplier * synonymPenalty * priorityMult;
}

/**
 * Entity Mention Score (v10 F5) — log-scaled mention_count boost + co-occurrence bonus.
 *
 * Each query entity found in the chunk contributes log2(mentionCount+1)/6,
 * capped at 1.0. Co-occurring entities (chunk mentions both the query entity
 * AND another known co-entity) add a per-pair bonus capped at 0.15.
 *
 * @param {object} chunk — must have chunk.entities as a JSON string array
 * @param {string[]} queryEntities — normalized lowercase entity names
 * @param {Map<string, {mentionCount:number, coEntities:object}>} entityIndexMap
 * @returns {number} 0..1
 */
function entityMentionScore(chunk, queryEntities, entityIndexMap) {
  if (!queryEntities || queryEntities.length === 0) return 0;
  if (!entityIndexMap || entityIndexMap.size === 0) return 0;

  let chunkEntities;
  try {
    chunkEntities = JSON.parse(chunk.entities || '[]').map(e => String(e).toLowerCase().replace(/^@/, ''));
  } catch (_) {
    return 0;
  }
  if (chunkEntities.length === 0) return 0;

  let total = 0;
  for (const qEntity of queryEntities) {
    if (!chunkEntities.includes(qEntity)) continue;
    const entry = entityIndexMap.get(qEntity);
    if (!entry) continue;
    // Log-scaled mention boost — saturates around mention_count ~64 (2^6 - 1)
    total += Math.min(1.0, Math.log2(entry.mentionCount + 1) / 6);
    // Co-occurrence bonus — reward chunks that surface related entities
    for (const chunkEntity of chunkEntities) {
      if (chunkEntity === qEntity) continue;
      const coCount = (entry.coEntities && entry.coEntities[chunkEntity]) || 0;
      if (coCount > 0) total += Math.min(0.15, coCount / 20);
    }
  }
  return Math.min(1.0, total);
}

/**
 * Normalize FTS5 rank values across a set of results to 0-1 range.
 * Mutates results in place, setting _normalizedFts on each.
 */
function normalizeFtsScores(results) {
  if (results.length === 0) return;
  if (results.length === 1) {
    results[0]._normalizedFts = 1.0;
    return;
  }
  // Percentile-based normalization: use p10/p90 to resist outlier distortion
  const ranks = results.map(r => r.rank);
  const sorted = [...ranks].sort((a, b) => a - b);
  const p10 = sorted[Math.floor(sorted.length * 0.1)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  const range = p90 - p10 || 1;
  for (const r of results) {
    const clamped = Math.max(p10, Math.min(p90, r.rank));
    r._normalizedFts = 0.3 + 0.7 * (p90 - clamped) / range;
  }
}

const PROFILES = {
  default: RECALL_PROFILE,
  'default-semantic': RECALL_SEMANTIC_PROFILE,
  cil: CIL_PROFILE,
  'cil-semantic': CIL_SEMANTIC_PROFILE,
  assistant: ASSISTANT_PROFILE,
  'assistant-semantic': ASSISTANT_SEMANTIC_PROFILE,
  // v10 F1 Orchestrator strategies (additive — see scoring.js header comment)
  entity_brief: ENTITY_BRIEF_PROFILE,
  'entity_brief-semantic': ENTITY_BRIEF_SEMANTIC_PROFILE,
  timeline_brief: TIMELINE_BRIEF_PROFILE,
  'timeline_brief-semantic': TIMELINE_BRIEF_SEMANTIC_PROFILE,
  relationship_brief: RELATIONSHIP_BRIEF_PROFILE,
  'relationship_brief-semantic': RELATIONSHIP_BRIEF_SEMANTIC_PROFILE,
  verification_lookup: VERIFICATION_LOOKUP_PROFILE,
  'verification_lookup-semantic': VERIFICATION_LOOKUP_SEMANTIC_PROFILE,
  quick_context: RECALL_PROFILE,                    // alias for fallback
  'quick_context-semantic': RECALL_SEMANTIC_PROFILE,
};

/**
 * Resolve a profile by name, with optional semantic variant.
 * @param {string} name — 'default', 'assistant', or 'cil'
 * @param {boolean} semantic — if true, return the semantic variant
 * @returns {object} profile
 */
function resolveProfile(name, semantic = false) {
  const key = semantic ? `${name}-semantic` : name;
  return PROFILES[key] || (semantic ? RECALL_SEMANTIC_PROFILE : RECALL_PROFILE);
}

module.exports = {
  TYPE_BONUS,
  PRIORITY_MULTIPLIER,
  DOMAIN_HALF_LIFE,
  getDomainHalfLife,
  computeTemporalRelevance,
  RECALL_PROFILE,
  RECALL_SEMANTIC_PROFILE,
  CIL_PROFILE,
  CIL_SEMANTIC_PROFILE,
  ASSISTANT_PROFILE,
  ASSISTANT_SEMANTIC_PROFILE,
  PROFILES,
  resolveProfile,
  getDynamicFileWeight,
  score,
  entityMentionScore,
  normalizeFtsScores,
  opsNoisePenalty,
  metadataDensityPenalty,
  OPS_NOISE_RE,
  NOISE_EXEMPT_TYPES,
};
