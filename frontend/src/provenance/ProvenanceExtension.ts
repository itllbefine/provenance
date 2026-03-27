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
 * Convert a ProseMirror position to a plain-text index.
 *
 * Uses `textBetween(0, pos, '\n', '\n')` — paragraph boundaries and
 * hardBreaks both become '\n', giving a structure-independent character
 * index that works regardless of node nesting (lists, blockquotes, etc.).
 *
 * This is the key fix for position drift: PM positions depend on document
 * structure (each wrapper node adds 2 tokens), but text positions don't.
 */
function pmToText(doc: import('@tiptap/pm/model').Node, pmPos: number): number {
  // Clamp to valid range — pos 0 is before the first node token,
  // and content.size is the last valid position.
  const clampedPos = Math.min(Math.max(pmPos, 0), doc.content.size)
  return doc.textBetween(0, clampedPos, '\n', '\n').length
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
 *
 * Position handling:
 * - PM positions depend on document node structure (lists, blockquotes add
 *   extra wrapper tokens). To avoid position drift from structural changes
 *   (ReplaceAroundStep for list wrapping, etc.), we convert PM positions to
 *   structure-independent text positions before emitting events.
 * - We track intermediate document states through multi-step transactions so
 *   each step's positions are converted relative to the correct doc state.
 * - Non-ReplaceStep steps (ReplaceAroundStep, AddMarkStep, etc.) advance the
 *   intermediate doc but don't emit events — the text position conversion
 *   automatically accounts for any structural shifts they cause.
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

    // Skip initialization transactions. When TipTap switches content via
    // editor.commands.setContent(), it sets 'preventUpdate' meta. We don't
    // want to log that wholesale replacement as a series of user edits.
    if (transaction.getMeta('preventUpdate')) return

    const now = new Date().toISOString()

    // Check whether this transaction was dispatched by accepting an AI suggestion.
    const aiMeta = transaction.getMeta('ai_suggestion') as AiSuggestionMeta | undefined
    const author = aiMeta?.author ?? 'local_user'

    // Track intermediate document state for multi-step transactions.
    // step.from / step.to are positions in the doc AFTER all preceding steps
    // in this transaction, NOT in transaction.before. We apply each step to
    // get the correct intermediate doc for position conversion.
    let intermediateDoc = transaction.before

    for (const step of transaction.steps) {
      if (step instanceof ReplaceStep) {
        // Convert PM positions to plain-text positions.
        // This makes positions independent of document structure (lists,
        // blockquotes, headings all work correctly).
        const textFrom = pmToText(intermediateDoc, step.from)
        const textTo = pmToText(intermediateDoc, step.to)

        // Get deleted text from the intermediate doc (correct for multi-step txns).
        // '\n' as both blockSep and leafText ensures paragraph boundaries and
        // hardBreaks both produce '\n', keeping the text representation consistent.
        const deletedText = intermediateDoc.textBetween(step.from, step.to, '\n', '\n')

        // Get inserted text from the step's slice.
        const insertedText = step.slice.content.textBetween(
          0,
          step.slice.content.size,
          '\n',
          '\n',
        )

        // Structural-only changes (e.g. pressing Enter to split a paragraph):
        // the step inserts block-level tokens that shift PM positions but produce
        // no visible text. With '\n' as leafText, these now produce '\n' in
        // insertedText, so the check below catches the empty-text case only
        // when the slice truly has no content (e.g. collapsing an empty paragraph).
        if (!deletedText && !insertedText) {
          // Even with no text change, advance the intermediate doc below.
        } else {
          const event_type: RawProvenanceEvent['event_type'] =
            deletedText && insertedText
              ? 'replace'
              : deletedText
                ? 'delete'
                : 'insert'

          // For AI suggestions the edit_type is known from the meta. Human edits
          // are stored without a subtype — classification is disabled.
          const edit_type = aiMeta?.edit_type ?? null

          // 'human_edit' marks text that replaced existing content (deletedText non-empty).
          // Pure inserts ('human') are original first-draft typing and stay uncolored.
          const origin: RawProvenanceEvent['origin'] =
            aiMeta?.origin ?? (deletedText ? 'human_edit' : 'human')

          this.options.onEvent({
            event_type,
            from_pos: textFrom,
            to_pos: textTo,
            inserted_text: insertedText,
            deleted_text: deletedText,
            author,
            timestamp: now,
            origin,
            edit_type,
            pos_type: 'text',
          })
        }
      }

      // Advance to the next intermediate doc state, regardless of step type.
      // This is crucial: non-ReplaceStep steps (ReplaceAroundStep for list
      // wrapping, AddMarkStep for bold/italic, etc.) change PM positions.
      // By advancing the doc, the NEXT step's textBetween conversion
      // automatically accounts for any structural shifts.
      const result = step.apply(intermediateDoc)
      intermediateDoc = result.doc ?? intermediateDoc
    }
  },
})
