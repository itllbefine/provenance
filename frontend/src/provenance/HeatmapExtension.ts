import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { ReplaceStep } from '@tiptap/pm/transform'
import { classifyHumanEdit } from './classifier'

// The key lets us read plugin state from outside the plugin (e.g. to check
// whether heatmap mode is currently on).
export const heatmapKey = new PluginKey<HeatmapPluginState>('heatmap')

interface HeatmapPluginState {
  enabled: boolean
  // DecorationSet is an immutable, efficiently-mapped tree of ProseMirror
  // decorations. We hold one here and update it on every transaction.
  decorations: DecorationSet
}

// Teach TypeScript about the custom command we're adding.
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    heatmap: {
      toggleHeatmap: () => ReturnType
    }
  }
}

/**
 * A TipTap extension that renders a provenance heatmap by placing inline
 * ProseMirror decorations over text ranges.
 *
 * Phase 3 only tracks two states:
 *   - "human" — text the user has typed or pasted in the current session
 *   - (no decoration) — text that existed before this session
 *
 * How it works:
 * - The extension registers a ProseMirror plugin with persistent state.
 * - On every transaction the plugin:
 *     1. Remaps existing decorations through the transaction's mapping
 *        (so decorations follow their text as surrounding text is inserted/deleted).
 *     2. Inspects each ReplaceStep for newly inserted text and adds a new
 *        decoration spanning [from, from + insertedSize).
 * - The `props.decorations` callback returns the DecorationSet only when
 *   heatmap mode is enabled — so toggling is just a state change, not a
 *   decoration rebuild.
 * - A `toggleHeatmap` command dispatches a transaction carrying a meta value
 *   that flips the enabled flag in the plugin state.
 */
export const HeatmapExtension = Extension.create({
  name: 'heatmap',

  addCommands() {
    return {
      // Dispatches a no-op transaction whose only purpose is to carry the
      // { toggle: true } meta value, which the plugin state picks up.
      toggleHeatmap:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(heatmapKey, { toggle: true }))
          return true
        },
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<HeatmapPluginState>({
        key: heatmapKey,

        state: {
          init(_config, _state): HeatmapPluginState {
            return { enabled: false, decorations: DecorationSet.empty }
          },

          apply(tr, prev): HeatmapPluginState {
            // Check whether this transaction carries the toggle signal.
            const meta = tr.getMeta(heatmapKey) as { toggle?: boolean } | undefined
            const enabled = meta?.toggle ? !prev.enabled : prev.enabled

            // Content-initialization transactions (setContent, document switch)
            // carry addToHistory: false. Reset decorations so we don't carry
            // stale highlights across documents.
            if (tr.getMeta('addToHistory') === false) {
              return { enabled, decorations: DecorationSet.empty }
            }

            // DecorationSet.map() remaps all stored positions through the
            // transaction's step mappings. This keeps decorations attached to
            // their text as other text is inserted or deleted around them.
            let decorations = prev.decorations.map(tr.mapping, tr.doc)

            if (tr.docChanged) {
              // Check whether this transaction came from accepting an AI suggestion.
              const aiMeta = tr.getMeta('ai_suggestion') as { edit_type?: string } | undefined

              for (const step of tr.steps) {
                // Only ReplaceStep involves actual text content changes.
                if (!(step instanceof ReplaceStep)) continue

                // step.slice.content.size is the number of ProseMirror positions
                // the inserted content occupies (roughly: characters + node boundaries).
                const insertedSize = step.slice.content.size
                if (insertedSize === 0) continue

                // Choose the CSS modifier class based on who made the edit and
                // what type of edit it was, giving each combination a distinct color.
                const spanClass = aiMeta
                  ? aiEditTypeClass(aiMeta.edit_type)
                  : humanEditTypeClass(
                      step.slice.content.textBetween(0, step.slice.content.size, '\n'),
                      tr.before.textBetween(step.from, step.to, '\n'),
                    )

                // Add an inline decoration spanning the inserted range.
                // Decoration.inline() attaches a CSS class without wrapping the
                // text in a new DOM element — it merges class attributes instead.
                decorations = decorations.add(tr.doc, [
                  Decoration.inline(step.from, step.from + insertedSize, {
                    class: `heatmap-span ${spanClass}`,
                  }),
                ])
              }
            }

            return { enabled, decorations }
          },
        },

        props: {
          decorations(state) {
            const pluginState = heatmapKey.getState(state)
            if (!pluginState?.enabled) return DecorationSet.empty
            return pluginState.decorations
          },
        },
      }),
    ]
  },
})

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Map an AI suggestion's edit_type to a heatmap CSS modifier class.
 * The edit_type values come from the backend's SUGGESTION_TOOL schema:
 *   "grammar_fix" | "wording_change" | "organizational_move"
 */
function aiEditTypeClass(editType: string | undefined): string {
  switch (editType) {
    case 'grammar_fix':         return 'heatmap-span--ai-grammar-fix'
    case 'wording_change':      return 'heatmap-span--ai-wording-change'
    case 'organizational_move': return 'heatmap-span--ai-organizational-move'
    default:                    return 'heatmap-span--ai-modified'  // fallback
  }
}

/**
 * Classify a human edit and return the matching heatmap CSS modifier class.
 * Mirrors the classifier.ts rule so the heatmap color is applied immediately
 * (the backend's Claude-based classification updates the stored record later
 * but doesn't retroactively change in-session decorations).
 */
function humanEditTypeClass(inserted: string, deleted: string): string {
  const editType = classifyHumanEdit(inserted, deleted)
  switch (editType) {
    case 'human_grammar_fix':          return 'heatmap-span--human-grammar-fix'
    case 'human_wording_change':       return 'heatmap-span--human-wording-change'
    case 'human_organizational_move':  return 'heatmap-span--human-organizational-move'
    default:                           return 'heatmap-span--human'
  }
}
