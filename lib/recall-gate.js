'use strict';

/**
 * Recall Gate — pure-regex + token classifier that decides whether a message
 * warrants a full recall pipeline execution. Runs before CIL with zero DB access.
 *
 * Rationale: blocking LLM sub-agents that fire on every message (842ms+ per turn
 * including on "ok", "thanks") burn real cost on messages that don't need memory.
 * SME's answer is to skip the pipeline entirely for trivial messages.
 *
 * Usage:
 *   const { shouldRecall } = require('./recall-gate');
 *   const { shouldRecall: pass, reason } = shouldRecall(message, config);
 *   if (!pass) return { text: '', chunks: [], gated: true, gateReason: reason };
 */

// Tokenized approach — handles compound acks like "thanks, got it" and
// "ok cool thanks" that a single ^...$ regex can't anchor across punctuation.
const ACK_WORDS = new Set([
  'ok', 'okay', 'sure', 'thanks', 'thank', 'you', 'got', 'it',
  'lol', 'lmao', 'haha', 'yes', 'no', 'yep', 'nope', 'k', 'ty', 'np',
  'cool', 'nice', 'great', 'right', 'hmm', 'ah', 'oh', 'wow', 'brb', 'gg',
  'i', 'see', 'roger', 'copy', 'understood', 'noted', 'perfect', 'awesome',
]);

const MATH_EXPR = /^[\d\s+\-*/=().,%]+$/;
const SYSTEM_CMD = /^\/(clear|reset|help|version|status|quit|exit|debug)\b/i;

/**
 * True if every word in the message is a known acknowledgment word.
 * Tolerates punctuation, whitespace, and compound forms like "thanks, got it".
 */
function isAllAckWords(text) {
  const words = text.toLowerCase().replace(/[^\w\s]+/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  return words.every(w => ACK_WORDS.has(w));
}

/**
 * @param {string} message
 * @param {object} [config] — accepts { recallGating: { minMessageLength } }
 * @returns {{ shouldRecall: boolean, reason: string }}
 */
function shouldRecall(message, config = {}) {
  if (typeof message !== 'string') return { shouldRecall: false, reason: 'non-string input' };
  const trimmed = message.trim();
  const minLen = (config.recallGating && config.recallGating.minMessageLength) || 5;

  if (trimmed.length === 0) return { shouldRecall: false, reason: 'empty' };
  // Check specific patterns before length — acks/math/cmds are gated by category
  if (isAllAckWords(trimmed)) return { shouldRecall: false, reason: 'acknowledgment' };
  if (MATH_EXPR.test(trimmed) && /\d/.test(trimmed)) return { shouldRecall: false, reason: 'math expression' };
  if (SYSTEM_CMD.test(trimmed)) return { shouldRecall: false, reason: 'system command' };
  if (trimmed.length < minLen) return { shouldRecall: false, reason: 'too short' };

  return { shouldRecall: true, reason: 'passes gate' };
}

module.exports = { shouldRecall, isAllAckWords, ACK_WORDS, MATH_EXPR, SYSTEM_CMD };
