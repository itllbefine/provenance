import { Mark, mergeAttributes } from '@tiptap/core'

export type ProvenanceOrigin = 'human' | 'ai_influenced' | 'ai_assisted' | 'ai_generated'

// ── Commands ─────────────────────────────────────────────────────────────────

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    provenanceMark: {
      /** Apply a provenance mark to the current selection. */
      setProvenance: (attrs: { origin: ProvenanceOrigin; timestamp: string }) => ReturnType
      /** Remove the provenance mark from the current selection. */
      unsetProvenance: () => ReturnType
    }
  }
}

// ── Mark ─────────────────────────────────────────────────────────────────────

/**
 * A TipTap Mark that embeds provenance metadata directly in the ProseMirror
 * document schema. Unlike AttributionExtension (which uses ephemeral
 * decorations derived from backend heatmap spans), this mark is serialized
 * into the document JSON and persists across saves and reloads.
 *
 * Rendered HTML:  <span data-provenance data-origin="ai_generated" data-timestamp="2024-...">
 * Schema name:    'provenanceMark'  (distinct from ProvenanceExtension's 'provenance')
 */
export const ProvenanceMark = Mark.create({
  name: 'provenanceMark',

  // Provenance marks tag existing text ranges. Typing at the boundary should
  // not auto-extend the mark onto new characters.
  inclusive: false,

  addAttributes() {
    return {
      origin: {
        default: null,
        parseHTML: element => element.getAttribute('data-origin'),
        renderHTML: attributes => {
          if (!attributes.origin) return {}
          return { 'data-origin': attributes.origin }
        },
      },
      timestamp: {
        default: null,
        parseHTML: element => element.getAttribute('data-timestamp'),
        renderHTML: attributes => {
          if (!attributes.timestamp) return {}
          return { 'data-timestamp': attributes.timestamp }
        },
      },
    }
  },

  parseHTML() {
    // The attribute selector ensures only provenance spans are parsed into this
    // mark — not every <span> (AttributionExtension decorations use class
    // attributes, not data-provenance).
    return [{ tag: 'span[data-provenance]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ 'data-provenance': '' }, HTMLAttributes), 0]
  },

  addCommands() {
    return {
      setProvenance:
        (attrs) =>
        ({ commands }) => {
          return commands.setMark(this.name, attrs)
        },
      unsetProvenance:
        () =>
        ({ commands }) => {
          return commands.unsetMark(this.name)
        },
    }
  },
})
