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

// Teach TypeScript about the custom commands we're adding.
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    heatmap: {
      toggleHeatmap: () => ReturnType
      loadHeatmap: (decorations: DecorationSet) => ReturnType
    }
  }
}

/**
 * A TipTap extension that renders a provenance heatmap by placing inline
 * ProseMirror decorations over text ranges.
 *
 * Decorations come from two sources:
 *   1. **Loaded from backend** — the `loadHeatmap` command accepts a
 *      pre-built DecorationSet (constructed from replayed provenance events)
 *      and replaces the current set. This covers all historical edits.
 *   2. **Live tracking** — every ReplaceStep in a transaction adds a new
 *      inline decoration so edits made in the current session are colored
 *      immediately without a round-trip.
 *
 * The `props.decorations` callback returns the DecorationSet only when
 * heatmap mode is enabled — toggling is just a state flip.
 */
export const HeatmapExtension = Extension.create({
  name: 'heatmap',

  addCommands() {
    return {
      toggleHeatmap:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(heatmapKey, { toggle: true }))
          return true
        },
      loadHeatmap:
        (decorations: DecorationSet) =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(heatmapKey, { load: decorations }))
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
            const meta = tr.getMeta(heatmapKey) as
              | { toggle?: boolean; load?: DecorationSet }
              | undefined

            // Handle a full decoration set loaded from the backend.
            // This replaces any existing decorations and enables the heatmap.
            if (meta?.load) {
              return { enabled: true, decorations: meta.load }
            }

            const enabled = meta?.toggle ? !prev.enabled : prev.enabled

            // TipTap's setContent command (used for document switches) sets
            // 'preventUpdate' meta. Reset decorations so we don't carry stale
            // highlights from one document into the next.
            if (tr.getMeta('preventUpdate')) {
              return { enabled, decorations: DecorationSet.empty }
            }

            // DecorationSet.map() remaps all stored positions through the
            // transaction's step mappings.
            let decorations = prev.decorations.map(tr.mapping, tr.doc)

            if (tr.docChanged) {
              const aiMeta = tr.getMeta('ai_suggestion') as { edit_type?: string } | undefined

              // For multi-step transactions we need to map each step's
              // positions forward through all subsequent steps so the
              // decoration lands at the correct spot in tr.doc.
              const { steps, mapping } = tr
              for (let si = 0; si < steps.length; si++) {
                const step = steps[si]
                if (!(step instanceof ReplaceStep)) continue

                const insertedSize = step.slice.content.size
                if (insertedSize === 0) continue

                // Pure human inserts (nothing deleted) are original first-draft typing — no color.
                // Only color human edits where existing content was replaced.
                if (!aiMeta && step.from === step.to) continue

                // Map the step-local position through subsequent steps
                // to get the position in tr.doc.
                let from = step.from
                for (let mi = si + 1; mi < steps.length; mi++) {
                  from = mapping.maps[mi].map(from)
                }

                const spanClass = aiMeta
                  ? aiEditTypeClass(aiMeta.edit_type)
                  : humanEditTypeClass(
                      step.slice.content.textBetween(0, step.slice.content.size, '\n'),
                      tr.before.textBetween(step.from, step.to, '\n'),
                    )

                decorations = decorations.add(tr.doc, [
                  Decoration.inline(from, from + insertedSize, {
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
 */
function aiEditTypeClass(editType: string | undefined): string {
  switch (editType) {
    case 'grammar_fix':         return 'heatmap-span--ai-grammar-fix'
    case 'wording_change':      return 'heatmap-span--ai-wording-change'
    case 'organizational_move': return 'heatmap-span--ai-organizational-move'
    default:                    return 'heatmap-span--ai-modified'
  }
}

/**
 * Classify a human edit and return the matching heatmap CSS modifier class.
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

// ── Public helpers for building decorations from backend spans ───────────────

export interface HeatmapSpan {
  text: string
  origin: string
  edit_type: string | null
}

/**
 * Map an (origin, edit_type) pair from a backend span to the CSS class used
 * by the heatmap decorations.
 */
export function spanCssClass(origin: string, editType: string | null): string {
  // 'human' = original first-draft typing, never replaced — no heatmap color.
  if (origin === 'human') return ''

  // 'human_edit' = human replaced existing content — show human color.
  if (origin === 'human_edit') {
    switch (editType) {
      case 'human_grammar_fix':          return 'heatmap-span--human-grammar-fix'
      case 'human_wording_change':       return 'heatmap-span--human-wording-change'
      case 'human_organizational_move':  return 'heatmap-span--human-organizational-move'
      default:                           return 'heatmap-span--human'
    }
  }
  // AI origins
  switch (editType) {
    case 'grammar_fix':         return 'heatmap-span--ai-grammar-fix'
    case 'wording_change':      return 'heatmap-span--ai-wording-change'
    case 'organizational_move': return 'heatmap-span--ai-organizational-move'
    default:                    return 'heatmap-span--ai-modified'
  }
}
