'use strict';

/**
 * Memory Actions (v10 F4) — first-class mutation operations on stored chunks.
 *
 * Four actions:
 *   update   — rewrite content in-place, preserving id + created_at. Re-extracts
 *              entities from the new content so entity_index stays in sync after
 *              the next reflect cycle. FTS index updates via chunks_au trigger.
 *   replace  — archive the old chunk (confidence=0, superseded_by set,
 *              archived_at stamped) and insert a new chunk with the new content,
 *              re-extracted entities, and re-classified priority.
 *   forget   — soft-delete: confidence=0 + archived_at. Row preserved for
 *              auditability; falls below the recall minScore floor so it never
 *              surfaces again.
 *   protect  — set protected=1. reflect.js decay/markStale/pruneStale skip the
 *              chunk entirely.
 *
 * Target resolution:
 *   - numeric id or stringified number → direct SELECT WHERE id = ?
 *   - query string → run a recall, top result must (a) exist and
 *                    (b) not be within AMBIGUITY_DELTA of the second-best.
 *                    Ambiguous → AmbiguousTargetError with candidate review list.
 *                    Missing → TargetNotFoundError.
 */

const { recall } = require('./recall');
const { extractEntities } = require('./indexer');
const { classifyPriority } = require('./value-scoring');

class AmbiguousTargetError extends Error {
  constructor(candidates) {
    super('Target query matches multiple chunks (within ambiguity delta). Review the candidates and re-run with an explicit id.');
    this.name = 'AmbiguousTargetError';
    this.candidates = candidates;
  }
}

class TargetNotFoundError extends Error {
  constructor(target) {
    super(`No chunk found for target: ${target}`);
    this.name = 'TargetNotFoundError';
    this.target = target;
  }
}

// If the top two candidates are within this score delta, refuse the mutation
// and surface both for manual review. Relative gap > absolute threshold.
const AMBIGUITY_DELTA = 0.08;

/**
 * Resolve a target to a concrete chunk row.
 * @returns {object} chunk row from db
 */
function resolveTarget(db, target, { workspace = null } = {}) {
  if (target == null) throw new TargetNotFoundError(target);

  // Numeric id (number or all-digit string)
  const asNum = typeof target === 'number'
    ? target
    : /^\d+$/.test(String(target)) ? parseInt(target, 10) : null;
  if (asNum != null) {
    const row = db.prepare('SELECT * FROM chunks WHERE id = ?').get(asNum);
    if (!row) throw new TargetNotFoundError(target);
    return row;
  }

  if (typeof target !== 'string' || target.trim().length === 0) {
    throw new TargetNotFoundError(target);
  }

  // Query-based resolution. Bypass the config minScore floor AND the
  // diversity filter so low-scoring chunks and near-duplicates can still
  // be targeted — mutation ambiguity detection needs to see ALL candidates,
  // not just the top of each distinct cluster. Include stale chunks too.
  // recordStats: false — mutation-path lookups don't count as user recall.
  const results = recall(db, target, {
    limit: 5,
    workspace,
    includeStale: true,
    minScore: 0,
    skipDiversity: true,
    recordStats: false,
  });
  if (!results || results.length === 0) throw new TargetNotFoundError(target);

  const top = results[0];

  // Ambiguity check — top 2 within delta means we can't safely pick one
  if (results.length >= 2) {
    const delta = Math.abs((top.finalScore || top.score) - (results[1].finalScore || results[1].score));
    if (delta < AMBIGUITY_DELTA) {
      throw new AmbiguousTargetError(results.slice(0, 3).map(r => ({
        id: r.id,
        content: r.content,
        filePath: r.filePath,
        score: r.finalScore || r.score,
      })));
    }
  }

  // Recall returns a shaped object; fetch the raw row for mutation
  // Need to find the id — recall's output doesn't always include it
  // so match by content + file path
  const row = top.id != null
    ? db.prepare('SELECT * FROM chunks WHERE id = ?').get(top.id)
    : db.prepare('SELECT * FROM chunks WHERE file_path = ? AND content = ? LIMIT 1').get(top.filePath, top.content);
  if (!row) throw new TargetNotFoundError(target);
  return row;
}

/**
 * Execute a mutation action on a chunk.
 *
 * @param {Database} db
 * @param {object} params
 * @param {string} params.action — 'update' | 'replace' | 'forget' | 'protect'
 * @param {number|string} params.target — chunk id or query string
 * @param {string} [params.content] — required for update/replace
 * @param {string} [params.workspace]
 * @returns {object} result describing what happened
 */
function executeAction(db, { action, target, content = null, workspace = null } = {}) {
  if (!action) throw new Error('action is required');
  const chunk = resolveTarget(db, target, { workspace });
  const nowISO = new Date().toISOString();

  switch (action) {
    case 'update': {
      if (!content || typeof content !== 'string') throw new Error('update requires content');
      // Re-extract entities from new content so entity_index stays in sync
      // after the next reflect cycle. FTS updates via chunks_au trigger.
      const newEntities = JSON.stringify(extractEntities(content));
      db.prepare('UPDATE chunks SET content = ?, entities = ?, indexed_at = ? WHERE id = ?')
        .run(content, newEntities, nowISO, chunk.id);
      return { action, id: chunk.id, newContent: content };
    }

    case 'replace': {
      if (!content || typeof content !== 'string') throw new Error('replace requires content');
      // Re-extract entities + re-classify priority for the new content.
      // We use v9.1's classifyPriority (not a local classifier) so the new
      // chunk matches the rest of the corpus's tier conventions.
      const newEntities = JSON.stringify(extractEntities(content));
      let newPriority = 'medium';
      try {
        newPriority = classifyPriority({
          ...chunk,
          content,
          chunk_type: chunk.chunk_type,
        });
      } catch (_) { /* classifyPriority may fail on malformed input; fall back to medium */ }

      const insert = db.prepare(`
        INSERT INTO chunks (
          file_path, heading, content, line_start, line_end, entities,
          chunk_type, confidence, created_at, indexed_at, file_weight, priority
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      let newId = null;
      const tx = db.transaction(() => {
        const info = insert.run(
          chunk.file_path, chunk.heading, content,
          chunk.line_start, chunk.line_end, newEntities, chunk.chunk_type,
          1.0, nowISO, nowISO, chunk.file_weight || 1.0, newPriority
        );
        newId = info.lastInsertRowid;
        db.prepare('UPDATE chunks SET confidence = 0, superseded_by = ?, archived_at = ? WHERE id = ?')
          .run(newId, nowISO, chunk.id);
      });
      tx();
      return { action, oldId: chunk.id, newId, newContent: content, newPriority };
    }

    case 'forget': {
      db.prepare('UPDATE chunks SET confidence = 0, archived_at = ? WHERE id = ?')
        .run(nowISO, chunk.id);
      return { action, id: chunk.id };
    }

    case 'protect': {
      db.prepare('UPDATE chunks SET protected = 1 WHERE id = ?').run(chunk.id);
      return { action, id: chunk.id, protected: true };
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

module.exports = {
  executeAction,
  resolveTarget,
  AmbiguousTargetError,
  TargetNotFoundError,
  AMBIGUITY_DELTA,
};
