import { Extension } from '@tiptap/core'
import { ReplaceStep } from '@tiptap/pm/transform'
import DiffMatchPatch from 'diff-match-patch'
import type { RawProvenanceEvent, Suggestion } from '../api'
import { classifyHumanEdit } from './classifier'

const dmp = new DiffMatchPatch()

// Returns a 0–1 similarity score between two strings using diff-match-patch.
// Computed as: equal_chars / max(len(a), len(b))
function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  const diffs = dmp.diff_main(a, b)
  const equalChars = diffs
    .filter(([op]) => op === 0)
    .reduce((sum, [, text]) => sum + text.length, 0)
  return equalChars / maxLen
}

// The options we accept via ProvenanceExtension.configure({ ... })
interface ProvenanceOptions {
  // Called with each captured event. The caller is responsible for buffering
  // and sending events to the backend in batches.
  onEvent: (event: RawProvenanceEvent) => void
  // Returns the currently visible (not yet dismissed) suggestions so the
  // extension can detect AI-influenced human edits.
  getSuggestions: () => Suggestion[]
}

// Shape of the meta value set on transactions that apply an AI suggestion.
// EditorPanel sets this when dispatching an accepted suggestion so we can
// tag the provenance event with the correct origin.
interface AiSuggestionMeta {
  edit_type: string
  origin: 'ai_generated' | 'ai_modified'
  author: string
}

/**
 * A TipTap extension that watches every ProseMirror transaction and emits
 * provenance events for text insertions, deletions, and replacements.
 *
 * How it works:
 * - TipTap calls onTransaction() after each transaction is applied to the doc.
 * - A transaction contains an array of "steps" — atomic document mutations.
 * - We look for ReplaceStep, which covers all text-level changes (typing,
 *   deleting, pasting). Formatting-only changes (AddMarkStep, etc.) are skipped.
 * - For each ReplaceStep we extract:
 *     deletedText — what was in [from, to] before the step
 *     insertedText — what the step put in its place
 *   and classify the event as 'insert', 'delete', or 'replace'.
 * - If the transaction carries an 'ai_suggestion' meta value, we use the
 *   author/origin/edit_type from that meta instead of the human defaults.
 */
export const ProvenanceExtension = Extension.create<ProvenanceOptions>({
  name: 'provenance',

  // Default options — onEvent is a no-op so the extension is safe to add
  // even before a real handler is wired up.
  addOptions() {
    return {
      onEvent: () => {},
      getSuggestions: (): Suggestion[] => [],
    }
  },

  onTransaction({ transaction }) {
    // Ignore transactions that didn't change the document text/structure
    if (!transaction.docChanged) return

    // Skip initialization transactions. When TipTap loads or switches content
    // via editor.commands.setContent(), it sends a transaction with
    // addToHistory: false. We don't want to log that as a user edit.
    if (transaction.getMeta('addToHistory') === false) return

    const now = new Date().toISOString()

    // Check whether this transaction was dispatched by accepting an AI suggestion.
    const aiMeta = transaction.getMeta('ai_suggestion') as AiSuggestionMeta | undefined
    const author = aiMeta?.author ?? 'local_user'
    const isHuman = !aiMeta

    for (const step of transaction.steps) {
      // ReplaceStep is the ProseMirror step type for all text-level changes.
      // Other step types (ReplaceAroundStep for list wrapping, Mark steps for
      // bold/italic, etc.) don't represent text content changes, so we skip them.
      if (!(step instanceof ReplaceStep)) continue

      // step.from / step.to are positions in the document BEFORE this step.
      // transaction.before is the document state before any steps in this
      // transaction were applied — so these positions are valid against it.
      const from = step.from
      const to = step.to

      // Get the text that was removed (empty string for a pure insert)
      const deletedText = transaction.before.textBetween(from, to, '\n')

      // Get the text being inserted. step.slice.content is a ProseMirror
      // Fragment (a sequence of nodes). textBetween() on a Fragment extracts
      // just the text, using '\n' where block boundaries fall.
      const insertedText = step.slice.content.textBetween(
        0,
        step.slice.content.size,
        '\n',
      )

      // Skip steps that have no visible text effect (e.g. pure node-structure
      // changes where both old and new content are empty)
      if (!deletedText && !insertedText) continue

      const event_type: RawProvenanceEvent['event_type'] =
        deletedText && insertedText
          ? 'replace'
          : deletedText
            ? 'delete'
            : 'insert'

      // For AI suggestions the edit_type is known from the meta. For human
      // edits, apply the rule-based classifier. Ambiguous cases (null) are
      // sent to the backend, which calls Claude to fill them in.
      const edit_type = aiMeta?.edit_type ?? classifyHumanEdit(insertedText, deletedText)

      // For human edits with enough content, check if the inserted text
      // closely matches any currently visible suggestion. If so, tag the
      // event as ai_influenced or ai_generated instead of plain human.
      let origin: RawProvenanceEvent['origin'] = aiMeta?.origin ?? 'human'
      if (isHuman && insertedText.length >= 10) {
        const activeSuggestions = this.options.getSuggestions()
        for (const suggestion of activeSuggestions) {
          const score = similarity(insertedText, suggestion.suggested_text)
          if (score === 1) {
            origin = 'ai_generated'
            break
          } else if (score >= 0.8) {
            origin = 'ai_influenced'
            // Don't break — a verbatim match from another suggestion could
            // still upgrade this to ai_generated.
          }
        }
      }

      this.options.onEvent({
        event_type,
        from_pos: from,
        to_pos: to,
        inserted_text: insertedText,
        deleted_text: deletedText,
        author,
        timestamp: now,
        origin,
        edit_type,
      })
    }
  },
})
