import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
// import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Document, RawProvenanceEvent, Suggestion } from '../api'
import { flushProvenanceEvents, createManualSnapshot } from '../api'
import { ProvenanceExtension } from '../provenance/ProvenanceExtension'
// import { HeatmapExtension, heatmapKey, spanCssClass } from '../provenance/HeatmapExtension'
import type { SaveStatus } from '../App'
import ProvenanceDebugPanel from './ProvenanceDebugPanel'
import YounessModal from './YounessModal'
import TimelineModal from './TimelineModal'
import './EditorPanel.css'

interface Props {
  documentId: string
  initialTitle: string
  initialContent: string
  initialContext: string
  allDocs: Document[]
  onNewDocument: () => void
  onSwitchDocument: (doc: Document) => void
  onChange: (title: string, content: string) => void
  onContextChange: (context: string) => void
  saveStatus: SaveStatus
  // Called once on mount with a function that accepts an AI suggestion.
  // The function returns true if the original text was found and replaced.
  onRegisterApplyEdit?: (fn: (original: string, suggested: string, editType: string, origin?: string) => boolean) => void
  // Called once on mount with a function that flushes pending provenance events.
  onRegisterFlushEvents?: (fn: () => Promise<void>) => void
  // Called whenever the editor selection changes: non-empty text when the user
  // selects something, null when the cursor is placed without a selection.
  // Does NOT fire on blur — the stored selection persists when focus moves away.
  onSelectionChange?: (text: string | null) => void
  getSuggestions: () => Suggestion[]
}

const SAVE_LABEL: Record<SaveStatus, string> = {
  saved: 'Saved',
  saving: 'Saving…',
  unsaved: 'Unsaved changes',
  error: 'Save failed',
}

// /**
//  * Build a ProseMirror DecorationSet from backend provenance spans.
//  *
//  * The spans are ordered text fragments whose concatenation (minus '\n'
//  * boundary markers) equals the document's plain text.  We walk the PM
//  * document's text nodes in order, advancing through the span characters
//  * in lockstep, and create one Decoration.inline per contiguous run of
//  * the same (origin, edit_type).
//  */
// function buildDecorationsFromSpans(
//   doc: import('@tiptap/pm/model').Node,
//   spans: TimelineSpan[],
// ): DecorationSet {
//   // Flatten spans into per-character provenance, skipping boundaries and '\n'.
//   const chars: { cls: string }[] = []
//   for (const span of spans) {
//     if (span.origin === 'boundary') continue
//     // 'human' = original unmodified text, no decoration. Still add entries so
//     // charIdx stays aligned with document positions for subsequent spans.
//     const modifierCls = spanCssClass(span.origin, span.edit_type)
//     const cls = modifierCls ? `heatmap-span ${modifierCls}` : ''
//     for (const ch of span.text) {
//       if (ch === '\n') continue
//       chars.push({ cls })
//     }
//   }
//
//   const decorations: Decoration[] = []
//   let charIdx = 0
//
//   doc.descendants((node, pos) => {
//     if (!node.isText || !node.text) return
//     let runStart = pos
//     let runCls = charIdx < chars.length ? chars[charIdx].cls : ''
//
//     for (let i = 0; i < node.text.length; i++) {
//       const cls = charIdx < chars.length ? chars[charIdx].cls : ''
//       charIdx++
//
//       if (cls !== runCls) {
//         // Flush the previous run
//         if (runCls) {
//           decorations.push(Decoration.inline(runStart, pos + i, { class: runCls }))
//         }
//         runStart = pos + i
//         runCls = cls
//       }
//     }
//     // Flush the final run for this text node
//     if (runCls) {
//       decorations.push(Decoration.inline(runStart, pos + node.text.length, { class: runCls }))
//     }
//   })
//
//   return DecorationSet.create(doc, decorations)
// }

/** Parse stored JSON string back to a ProseMirror doc object, or '' for empty. */
function parseContent(raw: string) {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return Object.keys(parsed).length === 0 ? '' : parsed
  } catch {
    return ''
  }
}

export default function EditorPanel({
  documentId,
  initialTitle,
  initialContent,
  initialContext,
  allDocs,
  onNewDocument,
  onSwitchDocument,
  onChange,
  onContextChange,
  saveStatus,
  onRegisterApplyEdit,
  onRegisterFlushEvents,
  onSelectionChange,
  getSuggestions,
}: Props) {
  const [title, setTitle] = useState(initialTitle)
  const [context, setContext] = useState(initialContext)
  const [showContext, setShowContext] = useState(false)
  const [showDebug, setShowDebug] = useState(false)
  const [showYouness, setShowYouness] = useState(false)
  const [showTimeline, setShowTimeline] = useState(false)
  const [showDocPicker, setShowDocPicker] = useState(false)
  const [showAttribution, setShowAttribution] = useState(false)
  const [snapshotting, setSnapshotting] = useState(false)
  const [wordCount, setWordCount] = useState(0)
  const docPickerRef = useRef<HTMLDivElement>(null)
  const attributionRef = useRef<HTMLDivElement>(null)
  // const [heatmapLoading, setHeatmapLoading] = useState(false)

  // Refs to prevent stale closures in editor callbacks.
  // See the comment in the original EditorPanel for a full explanation.
  const titleRef = useRef(title)
  titleRef.current = title

  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // documentId can change when the user switches documents. We keep a ref so
  // the provenance flush callback always tags events with the correct ID even
  // though the callback itself is created only once (on editor mount).
  const documentIdRef = useRef(documentId)
  documentIdRef.current = documentId

  // Buffer for provenance events accumulated since the last flush.
  const pendingEventsRef = useRef<RawProvenanceEvent[]>([])

  // Stable callback — reads from refs, so it always has current values.
  const handleProvenanceEventRef = useRef((event: RawProvenanceEvent) => {
    pendingEventsRef.current.push(event)
  })

  // Keep a ref to getSuggestions so the extension always sees the latest list
  // without needing to be reconfigured.
  const getSuggestionsRef = useRef(getSuggestions)
  getSuggestionsRef.current = getSuggestions

  // Track whether the editor currently has focus so onSelectionUpdate can
  // distinguish "user actively changed selection" from "blur collapsed it".
  const editorFocusedRef = useRef(false)
  const onSelectionChangeRef = useRef(onSelectionChange)
  onSelectionChangeRef.current = onSelectionChange

  // Flush the pending event buffer to the backend.
  async function flushEvents() {
    const events = pendingEventsRef.current
    if (events.length === 0) return
    pendingEventsRef.current = []
    try {
      await flushProvenanceEvents(documentIdRef.current, events)
    } catch (err) {
      console.error('Provenance flush failed:', err)
      // Put the events back so they aren't lost on a transient error.
      pendingEventsRef.current = [...events, ...pendingEventsRef.current]
    }
  }

  // Flush every 2 seconds. Clean up on unmount.
  useEffect(() => {
    const interval = setInterval(flushEvents, 2000)
    return () => {
      clearInterval(interval)
      // Final flush when the component unmounts (e.g. document switch)
      void flushEvents()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Expose flushEvents to parent so it can flush before generating suggestions.
  useEffect(() => {
    onRegisterFlushEvents?.(flushEvents)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onRegisterFlushEvents])

  // Close the doc-picker when the user clicks outside of it.
  useEffect(() => {
    if (!showDocPicker) return
    function handleClickOutside(e: MouseEvent) {
      if (docPickerRef.current && !docPickerRef.current.contains(e.target as Node)) {
        setShowDocPicker(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showDocPicker])

  // Close the attribution dropdown when the user clicks outside of it.
  useEffect(() => {
    if (!showAttribution) return
    function handleClickOutside(e: MouseEvent) {
      if (attributionRef.current && !attributionRef.current.contains(e.target as Node)) {
        setShowAttribution(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showAttribution])

  // Configure the provenance extension once. useMemo with [] means this
  // object is created once on mount and never re-created. The callback
  // reads from handleProvenanceEventRef so it always calls the current handler.
  const provenanceExtension = useMemo(
    () =>
      ProvenanceExtension.configure({
        onEvent: (e) => handleProvenanceEventRef.current(e),
        getSuggestions: () => getSuggestionsRef.current(),
      }),
    [],
  )

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      provenanceExtension,
      // HeatmapExtension,
    ],
    content: parseContent(initialContent),
    editorProps: {
      attributes: { spellcheck: 'true' },
    },
    onFocus() {
      editorFocusedRef.current = true
    },
    onBlur() {
      // Mark as unfocused. ProseMirror does not dispatch a selection transaction
      // on blur, so onSelectionUpdate will not fire — the stored selection in
      // App state persists when focus moves to the chat input.
      editorFocusedRef.current = false
    },
    onSelectionUpdate({ editor }) {
      // Only act when the editor has focus so we don't respond to programmatic
      // selection changes (e.g. applyEdit moving the cursor).
      if (!editorFocusedRef.current) return
      const { from, to } = editor.state.selection
      if (from === to) {
        // Cursor placed with no selection — clear any stored selection.
        onSelectionChangeRef.current?.(null)
      } else {
        const text = editor.state.doc.textBetween(from, to, '\n\n', '\n')
        onSelectionChangeRef.current?.(text || null)
      }
    },
    onUpdate({ editor }) {
      onChangeRef.current(titleRef.current, JSON.stringify(editor.getJSON()))
      const text = editor.getText()
      setWordCount(text.trim() === '' ? 0 : text.trim().split(/\s+/).length)
    },
  })

  // Register editor callbacks with the parent once the editor is ready.
  useEffect(() => {
    if (!editor) return

    if (!onRegisterApplyEdit) return

    // Finds `originalText` in the document by walking all text nodes and
    // building a flat character→position map. Then dispatches a replacement
    // transaction tagged with 'ai_suggestion' meta so ProvenanceExtension and
    // HeatmapExtension can record the correct authorship.
    function applyEdit(originalText: string, suggestedText: string, editType: string, origin = 'ai_modified'): boolean {
      const { state } = editor!
      const { doc, schema } = state

      // Build a flat array: for each character in text nodes, record its
      // absolute ProseMirror position. This lets us map a string-index match
      // back to document positions even across adjacent text nodes.
      // '\n\n' is inserted at each paragraph boundary, matching what
      // extract_text() in the backend sends to Claude. This lets originalText
      // spanning a paragraph break be found correctly. Boundary entries get
      // posMap value -1 (virtual — no real PM position for the newlines).
      const posMap: number[] = []
      let combined = ''
      let lastTextEnd = -1
      doc.descendants((node, pos) => {
        if (node.type.name === 'hardBreak') {
          if (lastTextEnd !== -1 && pos > lastTextEnd + 1) {
            posMap.push(-1, -1)
            combined += '\n\n'
          }
          posMap.push(-1)
          combined += '\n'
          lastTextEnd = pos + 1
          return
        }
        if (!node.isText || !node.text) return
        if (lastTextEnd !== -1 && pos > lastTextEnd + 1) {
          posMap.push(-1, -1)
          combined += '\n\n'
        }
        for (let i = 0; i < node.text.length; i++) {
          posMap.push(pos + i)
          combined += node.text[i]
        }
        lastTextEnd = pos + node.text.length
      })

      const idx = combined.indexOf(originalText)
      if (idx === -1) return false

      // If originalText spans a paragraph boundary, posMap at the start or end
      // may be -1 (the virtual space). Scan to the nearest real position.
      let fromIdx = idx
      while (fromIdx < posMap.length && posMap[fromIdx] === -1) fromIdx++
      let toIdx = idx + originalText.length - 1
      while (toIdx >= 0 && posMap[toIdx] === -1) toIdx--

      const from = posMap[fromIdx]
      const to = posMap[toIdx] + 1

      // Preserve marks at the insertion point (e.g. bold, italic).
      const marks = doc.resolve(from).marks()
      const newContent = suggestedText
        ? schema.text(suggestedText, marks)
        : null

      const tr = state.tr
      if (newContent) {
        tr.replaceWith(from, to, newContent)
      } else {
        tr.delete(from, to)
      }
      tr.setMeta('ai_suggestion', {
        edit_type: editType,
        origin,
        author: 'claude-sonnet-4-6',
      })

      editor!.view.dispatch(tr)
      return true
    }

    onRegisterApplyEdit(applyEdit)
  }, [editor, onRegisterApplyEdit])

  function handleTitleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const newTitle = e.target.value
    setTitle(newTitle)
    titleRef.current = newTitle
    if (editor) {
      onChangeRef.current(newTitle, JSON.stringify(editor.getJSON()))
    }
  }

  // async function handleHeatmapToggle() {
  //   if (!editor) return
  //   const isEnabled = heatmapKey.getState(editor.state)?.enabled
  //   if (isEnabled) {
  //     // Turning off — just toggle
  //     editor.chain().focus().toggleHeatmap().run()
  //     return
  //   }
  //   // Turning on — flush pending events, then fetch provenance from backend
  //   // and build a full decoration set before enabling.
  //   setHeatmapLoading(true)
  //   try {
  //     await flushEvents()
  //     const spans = await getHeatmapSpans(documentIdRef.current)
  //     const decos = buildDecorationsFromSpans(editor.state.doc, spans)
  //     editor.chain().focus().loadHeatmap(decos).run()
  //   } catch (err) {
  //     console.error('Heatmap load failed:', err)
  //     // Fall back to showing whatever live decorations exist
  //     editor.chain().focus().toggleHeatmap().run()
  //   } finally {
  //     setHeatmapLoading(false)
  //   }
  // }

  // When the user switches to a different document, reload the editor content
  useEffect(() => {
    if (editor) {
      editor.commands.setContent(parseContent(initialContent))
      setTitle(initialTitle)
      setContext(initialContext)
      const text = editor.getText()
      setWordCount(text.trim() === '' ? 0 : text.trim().split(/\s+/).length)
    }
    // Only run when documentId changes, not on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId])

  // Manual attribution: push a provenance event that re-tags the selected text
  // with a new origin. The content doesn't change — only the provenance tag does.
  function handleAttribution(origin: string) {
    if (!editor) return
    const { from, to } = editor.state.selection
    if (from === to) return
    const selectedText = editor.state.doc.textBetween(from, to, '\n')
    if (!selectedText) return

    pendingEventsRef.current.push({
      event_type: 'replace',
      from_pos: from,
      to_pos: to,
      inserted_text: selectedText,
      deleted_text: selectedText,
      author: 'local_user',
      timestamp: new Date().toISOString(),
      origin: origin as RawProvenanceEvent['origin'],
      edit_type: null,
    })
    setShowAttribution(false)
  }

  async function handleSnapshot() {
    if (snapshotting) return
    setSnapshotting(true)
    try {
      await flushEvents()
      await createManualSnapshot(documentIdRef.current)
    } catch (err) {
      console.error('Snapshot failed:', err)
    } finally {
      setSnapshotting(false)
    }
  }

  const hasSelection = editor ? editor.state.selection.from !== editor.state.selection.to : false

  if (!editor) return null

  return (
    <div className="editor-panel">
      <div className="editor-toolbar">
        <button
          onClick={() => editor.chain().focus().toggleBold().run()}
          className={editor.isActive('bold') ? 'active' : ''}
          title="Bold"
        >
          B
        </button>
        <button
          onClick={() => editor.chain().focus().toggleItalic().run()}
          className={editor.isActive('italic') ? 'active' : ''}
          title="Italic"
        >
          I
        </button>

        <div className="toolbar-divider" />

        {([1, 2, 3] as const).map((level) => (
          <button
            key={level}
            onClick={() => editor.chain().focus().toggleHeading({ level }).run()}
            className={editor.isActive('heading', { level }) ? 'active' : ''}
            title={`Heading ${level}`}
          >
            H{level}
          </button>
        ))}

        <div className="toolbar-divider" />

        <button
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          className={editor.isActive('bulletList') ? 'active' : ''}
          title="Bullet list"
        >
          • —
        </button>
        <button
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          className={editor.isActive('orderedList') ? 'active' : ''}
          title="Numbered list"
        >
          1 —
        </button>
        <button
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          className={editor.isActive('blockquote') ? 'active' : ''}
          title="Blockquote"
        >
          &ldquo;
        </button>

        <div className="toolbar-divider" />

        {/* <button
          onClick={() => void handleHeatmapToggle()}
          className={heatmapKey.getState(editor.state)?.enabled ? 'active' : ''}
          disabled={heatmapLoading}
          title="Toggle heatmap view"
        >
          {heatmapLoading ? 'Loading…' : 'Heat'}
        </button> */}

        <button
          onClick={() => setShowDebug((v) => !v)}
          className={showDebug ? 'active' : ''}
          title="Toggle provenance log"
        >
          Log
        </button>

        <button
          onClick={() => setShowYouness(true)}
          title="You-ness score"
        >
          Score
        </button>

        <button
          onClick={() => setShowTimeline(true)}
          title="Document timeline"
        >
          Timeline
        </button>

        <button
          onClick={() => void handleSnapshot()}
          disabled={snapshotting}
          title="Capture a manual timeline snapshot"
        >
          {snapshotting ? 'Saving…' : 'Snapshot'}
        </button>

        <button
          onClick={() => setShowContext((v) => !v)}
          className={showContext ? 'active' : ''}
          title="Document context"
        >
          Context
        </button>

        <div className="attribution-wrapper" ref={attributionRef}>
          <button
            onClick={() => setShowAttribution((v) => !v)}
            className={showAttribution ? 'active' : ''}
            disabled={!hasSelection}
            title={hasSelection ? 'Set provenance for selected text' : 'Select text first'}
          >
            Attribute
          </button>
          {showAttribution && hasSelection && (
            <div className="attribution-dropdown">
              <button onClick={() => handleAttribution('human')}>Human</button>
              <button onClick={() => handleAttribution('ai_influenced')}>AI Influenced</button>
              <button onClick={() => handleAttribution('ai_modified')}>AI Assisted</button>
              <button onClick={() => handleAttribution('ai_generated')}>AI Generated</button>
            </div>
          )}
        </div>

        <div className="toolbar-spacer" />

        <span className="word-count">{wordCount} {wordCount === 1 ? 'word' : 'words'}</span>

        <span className={`save-status save-status--${saveStatus}`}>
          {SAVE_LABEL[saveStatus]}
        </span>
      </div>

      {showContext && (
        <div className="context-panel">
          <label className="context-label" htmlFor="doc-context">
            Document context
          </label>
          <textarea
            id="doc-context"
            className="context-textarea"
            value={context}
            onChange={(e) => {
              setContext(e.target.value)
              onContextChange(e.target.value)
            }}
            placeholder={'Describe the purpose, tone, and audience — e.g. "persuasive essay aimed at policy makers" or "technical API reference for developers". Claude will use this when generating suggestions.'}
            rows={3}
          />
        </div>
      )}

      <div className="title-row" ref={docPickerRef}>
        <button
          className="doc-picker-trigger"
          onClick={() => setShowDocPicker((v) => !v)}
          title="Switch document"
        >
          ▾
        </button>
        {showDocPicker && (
          <div className="doc-picker-dropdown">
            <button
              className="doc-picker-new"
              onClick={() => { onNewDocument(); setShowDocPicker(false) }}
            >
              + New document
            </button>
            {allDocs.map((d) => (
              <button
                key={d.id}
                className={`doc-picker-item${d.id === documentId ? ' doc-picker-item--active' : ''}`}
                onClick={() => { onSwitchDocument(d); setShowDocPicker(false) }}
              >
                {d.title || 'Untitled'}
              </button>
            ))}
          </div>
        )}
        <input
          className="document-title"
          value={title}
          onChange={handleTitleChange}
          placeholder="Untitled"
        />
      </div>

      <EditorContent editor={editor} className="editor-content" />

      {showDebug && <ProvenanceDebugPanel documentId={documentId} />}

      {showYouness && (
        <YounessModal
          documentId={documentId}
          onClose={() => setShowYouness(false)}
        />
      )}

      {showTimeline && (
        <TimelineModal
          documentId={documentId}
          onClose={() => setShowTimeline(false)}
        />
      )}
    </div>
  )
}
