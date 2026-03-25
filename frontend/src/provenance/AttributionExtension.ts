import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { Node as PmNode } from '@tiptap/pm/model'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { ReplaceStep } from '@tiptap/pm/transform'
import DiffMatchPatch from 'diff-match-patch'
import type { TimelineSpan } from '../api'

// ── Plugin state & key ───────────────────────────────────────────────────────

interface AttrState {
  enabled: boolean
  decorations: DecorationSet
}

export const attributionKey = new PluginKey<AttrState>('attribution')

// ── Commands ─────────────────────────────────────────────────────────────────

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    attribution: {
      /** Replace the entire decoration set and enable the view. */
      setAttributionDecos: (decorations: DecorationSet) => ReturnType
      /** Clear all decorations and disable the view. */
      clearAttributionDecos: () => ReturnType
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Map a provenance origin to the CSS class(es) for the editor decoration. */
export function originToClass(origin: string): string {
  switch (origin) {
    case 'ai_influenced':
      return 'attr-span attr-span--influenced'
    case 'ai_modified':
    case 'ai_collaborative':
      return 'attr-span attr-span--assisted'
    case 'ai_generated':
      return 'attr-span attr-span--generated'
    default:
      return '' // human / human_edit → no decoration
  }
}

/**
 * Build a ProseMirror DecorationSet from backend timeline/heatmap spans.
 *
 * Flattens span text (skipping '\n' and 'boundary') into a string with
 * per-character origins, then aligns it against the PM doc's actual text.
 * When lengths match we use direct 1:1 mapping; when they differ (e.g.
 * accumulated position drift from old events) we use diff-match-patch to
 * robustly align origins onto the real document text.
 */
export function buildDecorationsFromSpans(
  doc: PmNode,
  spans: TimelineSpan[],
): DecorationSet {
  // 1. Build flat span string + per-char origin array (skip '\n' and boundary)
  const spanChars: string[] = []
  const spanOrigins: string[] = []
  for (const span of spans) {
    if (span.origin === 'boundary') continue
    for (const ch of span.text) {
      if (ch === '\n') continue
      spanChars.push(ch)
      spanOrigins.push(span.origin)
    }
  }
  const spanStr = spanChars.join('')

  // 2. Build flat PM doc text
  const pmChars: string[] = []
  doc.descendants((node) => {
    if (node.isText && node.text) {
      for (const ch of node.text) pmChars.push(ch)
    }
  })
  const pmStr = pmChars.join('')

  // 3. Produce a per-PM-char origin array, aligned via diff if needed
  let pmOrigins: string[]
  if (spanStr.length === pmStr.length) {
    // Fast path: 1:1
    pmOrigins = spanOrigins
  } else {
    // Use diff-match-patch to align span text onto PM text
    const dmp = new DiffMatchPatch()
    const diffs = dmp.diff_main(spanStr, pmStr)
    dmp.diff_cleanupSemantic(diffs)

    pmOrigins = []
    let spanIdx = 0
    for (const [op, text] of diffs) {
      if (op === 0) {
        // Equal: copy origins from span
        for (let i = 0; i < text.length; i++) {
          pmOrigins.push(spanIdx < spanOrigins.length ? spanOrigins[spanIdx] : 'human')
          spanIdx++
        }
      } else if (op === -1) {
        // Deleted from span (extra chars in replay buffer) — skip them
        spanIdx += text.length
      } else {
        // Inserted in PM (chars not in replay buffer) — default to human
        for (let i = 0; i < text.length; i++) {
          pmOrigins.push('human')
        }
      }
    }
  }

  // 4. Walk PM text nodes and build decorations from pmOrigins
  const decorations: Decoration[] = []
  let charIdx = 0

  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return

    let runStart = pos
    let runOrigin = charIdx < pmOrigins.length ? pmOrigins[charIdx] : 'human'

    for (let i = 0; i < node.text.length; i++) {
      const origin = charIdx < pmOrigins.length ? pmOrigins[charIdx] : 'human'
      charIdx++

      if (origin !== runOrigin) {
        const cls = originToClass(runOrigin)
        if (cls) {
          decorations.push(Decoration.inline(runStart, pos + i, { class: cls }))
        }
        runStart = pos + i
        runOrigin = origin
      }
    }
    const cls = originToClass(runOrigin)
    if (cls) {
      decorations.push(Decoration.inline(runStart, pos + node.text.length, { class: cls }))
    }
  })

  return DecorationSet.create(doc, decorations)
}

// ── Extension ────────────────────────────────────────────────────────────────

/**
 * A TipTap extension that renders origin-based provenance colors over editor
 * text. Decorations are managed externally via `setAttributionDecos` (built
 * from backend heatmap spans) and mapped through transactions automatically.
 *
 * AI suggestion acceptances are decorated immediately via transaction meta
 * interception so the user gets instant feedback without waiting for the next
 * backend refresh.
 */
export const AttributionExtension = Extension.create({
  name: 'attribution',

  addCommands() {
    return {
      setAttributionDecos:
        (decorations: DecorationSet) =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(attributionKey, { set: decorations }))
          return true
        },
      clearAttributionDecos:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(attributionKey, { clear: true }))
          return true
        },
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<AttrState>({
        key: attributionKey,

        state: {
          init(): AttrState {
            return { enabled: false, decorations: DecorationSet.empty }
          },

          apply(tr, prev): AttrState {
            const meta = tr.getMeta(attributionKey) as
              | { set?: DecorationSet; clear?: boolean }
              | undefined

            if (meta?.clear) {
              return { enabled: false, decorations: DecorationSet.empty }
            }
            if (meta?.set) {
              return { enabled: true, decorations: meta.set }
            }

            // setContent (doc switch) resets decorations
            if (tr.getMeta('preventUpdate')) {
              return { enabled: prev.enabled, decorations: DecorationSet.empty }
            }

            // Map existing decorations through the transaction
            let decorations = prev.decorations.map(tr.mapping, tr.doc)

            // Immediately decorate AI edits when the feature is active
            if (prev.enabled && tr.docChanged) {
              const aiMeta = tr.getMeta('ai_suggestion') as
                | { origin?: string }
                | undefined

              if (aiMeta?.origin) {
                const cls = originToClass(aiMeta.origin)
                if (cls) {
                  const { steps, mapping } = tr
                  for (let si = 0; si < steps.length; si++) {
                    const step = steps[si]
                    if (!(step instanceof ReplaceStep)) continue
                    const insertedSize = step.slice.content.size
                    if (insertedSize === 0) continue

                    // Map step-local position through subsequent steps
                    let from = step.from
                    for (let mi = si + 1; mi < steps.length; mi++) {
                      from = mapping.maps[mi].map(from)
                    }

                    decorations = decorations.add(tr.doc, [
                      Decoration.inline(from, from + insertedSize, {
                        class: cls,
                      }),
                    ])
                  }
                }
              }
            }

            return { enabled: prev.enabled, decorations }
          },
        },

        props: {
          decorations(state) {
            const pluginState = attributionKey.getState(state)
            if (!pluginState?.enabled) return DecorationSet.empty
            return pluginState.decorations
          },
        },
      }),
    ]
  },
})
