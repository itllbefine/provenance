import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import DiffMatchPatch from 'diff-match-patch'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DismissedSuggestion, Document, RawProvenanceEvent, Suggestion } from '../api'
import { flushProvenanceEvents, createManualSnapshot, getHeatmapSpans } from '../api'
import { ProvenanceExtension } from '../provenance/ProvenanceExtension'
import { AttributionExtension, buildDecorationsFromSpans } from '../provenance/AttributionExtension'
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
  archive: DismissedSuggestion[]
}

const SAVE_LABEL: Record<SaveStatus, string> = {
  saved: 'Saved',
  saving: 'Saving…',
  unsaved: 'Unsaved changes',
  error: 'Save failed',
}

const dmpInstance = new DiffMatchPatch()

/** Similarity score (0–1) using diff-match-patch Levenshtein distance. */
function textSimilarity(a: string, b: string): number {
  if (a === b) return 1
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  const diffs = dmpInstance.diff_main(a, b)
  const lev = dmpInstance.diff_levenshtein(diffs)
  return 1 - lev / maxLen
}

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
  archive,
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
  const [showSource, setShowSource] = useState(false)
  const showSourceRef = useRef(false)
  showSourceRef.current = showSource
  const docPickerRef = useRef<HTMLDivElement>(null)
  const attributionRef = useRef<HTMLDivElement>(null)

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

    // Accumulate human typing for debounced similarity checking.
    const isHuman = event.origin === 'human' || event.origin === 'human_edit'
    if (isHuman && event.inserted_text) {
      typingAccumRef.current.text += event.inserted_text

      // Reset the debounce timer — fires 2s after the last human keystroke.
      if (similarityTimerRef.current) clearTimeout(similarityTimerRef.current)
      similarityTimerRef.current = setTimeout(() => {
        retagPendingHumanEvents()
      }, 2000)
    }
  })

  // Keep a ref to getSuggestions so the debounced similarity check always
  // sees the latest list.
  const getSuggestionsRef = useRef(getSuggestions)
  getSuggestionsRef.current = getSuggestions

  // Keep a ref to the dismissed archive for the debounced similarity check.
  const archiveRef = useRef(archive)
  archiveRef.current = archive

  // Accumulator for human typing: text concatenates insertedText from human
  // events; watermark tracks which pending events have already been checked.
  const typingAccumRef = useRef({ text: '', watermark: 0 })
  const similarityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Check accumulated human typing against visible suggestions + dismissed archive.
  // If similarity is high enough, re-tag pending human events as ai_modified or
  // ai_influenced. Called on debounce (2s after typing stops) and before flush.
  function retagPendingHumanEvents() {
    const accum = typingAccumRef.current
    if (accum.text.length < 10) return

    // Build target list: suggested_text from visible suggestions + archive
    const suggestions = getSuggestionsRef.current()
    const dismissed = archiveRef.current

    let bestScore = 0
    for (const s of suggestions) {
      if (s.edit_type === 'observation') continue
      bestScore = Math.max(bestScore, textSimilarity(accum.text, s.suggested_text))
    }
    for (const d of dismissed) {
      if (d.edit_type === 'observation') continue
      bestScore = Math.max(bestScore, textSimilarity(accum.text, d.suggested_text))
    }

    // ≥80% → ai_modified ("AI Assisted"), 20–79% → ai_influenced, <20% → human (no change)
    let newOrigin: RawProvenanceEvent['origin'] | null = null
    if (bestScore >= 0.8) newOrigin = 'ai_modified'
    else if (bestScore >= 0.2) newOrigin = 'ai_influenced'

    if (newOrigin) {
      for (let i = accum.watermark; i < pendingEventsRef.current.length; i++) {
        const ev = pendingEventsRef.current[i]
        if (ev.origin === 'human' || ev.origin === 'human_edit') {
          pendingEventsRef.current[i] = { ...ev, origin: newOrigin }
        }
      }
    }

    // Reset: mark all current events as checked, clear accumulated text
    accum.text = ''
    accum.watermark = pendingEventsRef.current.length
  }

  // Track whether the editor currently has focus so onSelectionUpdate can
  // distinguish "user actively changed selection" from "blur collapsed it".
  const editorFocusedRef = useRef(false)
  const onSelectionChangeRef = useRef(onSelectionChange)
  onSelectionChangeRef.current = onSelectionChange

  // Ref to editor instance for use in callbacks defined before useEditor.
  const editorRef = useRef<ReturnType<typeof useEditor>>(null)

  // Fetch heatmap spans from the backend and rebuild the decoration set.
  // Called when the Source toggle is turned on and after each successful flush.
  async function refreshAttributionDecos() {
    const ed = editorRef.current
    if (!ed) return
    try {
      const spans = await getHeatmapSpans(documentIdRef.current)
      const decos = buildDecorationsFromSpans(ed.state.doc, spans)
      ed.commands.setAttributionDecos(decos)
    } catch (err) {
      console.error('Attribution refresh failed:', err)
    }
  }

  // Flush the pending event buffer to the backend.
  async function flushEvents() {
    // Run similarity check before flushing so events are re-tagged if needed.
    retagPendingHumanEvents()

    const events = pendingEventsRef.current
    if (events.length === 0) return
    pendingEventsRef.current = []
    // Buffer is empty — reset watermark so future events start from index 0.
    typingAccumRef.current.watermark = 0
    try {
      await flushProvenanceEvents(documentIdRef.current, events)
      // Refresh attribution decorations after a successful flush so colors
      // reflect any retagging (e.g. ai_influenced detection).
      if (showSourceRef.current) {
        void refreshAttributionDecos()
      }
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
      if (similarityTimerRef.current) clearTimeout(similarityTimerRef.current)
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
      }),
    [],
  )

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      provenanceExtension,
      AttributionExtension,
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

  // Keep editorRef in sync so callbacks defined before useEditor can access it.
  editorRef.current = editor

  // Register editor callbacks with the parent once the editor is ready.
  useEffect(() => {
    if (!editor) return

    if (!onRegisterApplyEdit) return

    // Finds `originalText` in the document by walking all text nodes and
    // building a flat character→position map. Then dispatches a replacement
    // transaction tagged with 'ai_suggestion' meta so ProvenanceExtension and
    // AttributionExtension can record the correct authorship.
    function applyEdit(originalText: string, suggestedText: string, editType: string, origin = 'ai_modified'): boolean {
      const { state } = editor!
      const { doc, schema } = state

      // Net-new insertion: append as a new paragraph at the end of the document
      if (!originalText) {
        if (!suggestedText) return false
        const tr = state.tr
        const paragraph = schema.nodes.paragraph.create(null, schema.text(suggestedText))
        tr.insert(doc.content.size, paragraph)
        tr.setMeta('ai_suggestion', { edit_type: editType, origin, author: 'claude-sonnet-4-6' })
        editor!.view.dispatch(tr)
        return true
      }

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

      let idx = combined.indexOf(originalText)

      // Fuzzy fallback: if exact match fails, use diff-match-patch to find
      // the best approximate match in the document.
      if (idx === -1) {
        const dmp = new DiffMatchPatch()
        // match_main returns the index of the best match, or -1.
        // Match_Threshold controls fuzziness (0 = exact, 1 = very loose).
        dmp.Match_Threshold = 0.4
        dmp.Match_Distance = 10000
        idx = dmp.match_main(combined, originalText, 0)
      }

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

  async function handleSourceToggle() {
    if (!editor) return
    if (showSource) {
      // Turning off
      editor.commands.clearAttributionDecos()
      setShowSource(false)
      return
    }
    // Turning on — flush pending events so backend has everything, then load.
    setShowSource(true)
    try {
      await flushEvents()
      const spans = await getHeatmapSpans(documentIdRef.current)
      const decos = buildDecorationsFromSpans(editor.state.doc, spans)
      editor.commands.setAttributionDecos(decos)
    } catch (err) {
      console.error('Source view load failed:', err)
    }
  }

  // When the user switches to a different document, reload the editor content
  // and refresh attribution decorations if the Source view is active.
  useEffect(() => {
    if (editor) {
      editor.commands.setContent(parseContent(initialContent))
      setTitle(initialTitle)
      setContext(initialContext)
      const text = editor.getText()
      setWordCount(text.trim() === '' ? 0 : text.trim().split(/\s+/).length)
      // Reload attribution decorations for the new document
      if (showSourceRef.current) {
        void refreshAttributionDecos()
      }
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

        <button
          onClick={() => void handleSourceToggle()}
          className={showSource ? 'active' : ''}
          title="Show text provenance colors"
        >
          Source
        </button>

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

      {showSource && (
        <div className="source-legend">
          <span className="source-legend-item">
            <span className="source-legend-swatch source-legend-swatch--human" />
            Human
          </span>
          <span className="source-legend-item">
            <span className="source-legend-swatch source-legend-swatch--influenced" />
            AI Influenced
          </span>
          <span className="source-legend-item">
            <span className="source-legend-swatch source-legend-swatch--assisted" />
            AI Assisted
          </span>
          <span className="source-legend-item">
            <span className="source-legend-swatch source-legend-swatch--generated" />
            AI Generated
          </span>
        </div>
      )}

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
