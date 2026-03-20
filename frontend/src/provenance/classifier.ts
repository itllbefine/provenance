/**
 * Rule-based classifier for human text edits.
 *
 * Used by both ProvenanceExtension (to tag provenance events sent to the
 * backend) and HeatmapExtension (to choose the decoration CSS class).
 * Keeping the logic in one place ensures both layers always agree.
 *
 * For edits that are ambiguous (returns null), the backend will call
 * Claude to classify them before storing the provenance record.
 */
export type HumanEditType =
  | 'human_grammar_fix'
  | 'human_wording_change'
  | 'human_organizational_move'

/**
 * Classify a human replacement (both inserted and deleted are non-empty).
 *
 * Rules:
 * - If stripping all non-word characters and lowercasing both sides gives
 *   the same string, only punctuation/capitalisation/whitespace changed
 *   → "human_grammar_fix"
 * - Otherwise → null (ambiguous; the backend will ask Claude)
 *
 * Pure inserts (typing) and pure deletes return null because:
 * - There is no "before" text to compare for pure inserts.
 * - Pure deletes produce no inserted text, so nothing to decorate on the heatmap.
 */
export function classifyHumanEdit(
  inserted: string,
  deleted: string,
): HumanEditType | null {
  if (!inserted || !deleted) {
    // Pure insert or pure delete: not classifiable with a simple rule.
    return null
  }

  // Strip every non-word character (punctuation, spaces, symbols) and
  // lowercase. The \p{L} and \p{N} Unicode categories cover letters and
  // digits across all scripts.
  const strip = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()

  if (strip(inserted) === strip(deleted)) {
    // The word-level content is identical; only punctuation, whitespace,
    // or capitalisation differed.
    return 'human_grammar_fix'
  }

  // Can't classify by rule alone. Backend will use Claude.
  return null
}
