import { Extension } from '@tiptap/core'
import { ReplaceStep } from '@tiptap/pm/transform'
import type { RawProvenanceEvent } from '../api'

// The options we accept via ProvenanceExtension.configure({ ... })
interface ProvenanceOptions {
  // Called with each captured event. The caller is responsible for buffering
  // and sending events to the backend in batches.
  onEvent: (event: RawProvenanceEvent) => void
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
    const origin: RawProvenanceEvent['origin'] = aiMeta?.origin ?? 'human'
    const edit_type = aiMeta?.edit_type ?? null

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
