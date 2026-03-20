import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { RawProvenanceEvent } from '../api'
import { flushProvenanceEvents } from '../api'
import { ProvenanceExtension } from '../provenance/ProvenanceExtension'
import { HeatmapExtension, heatmapKey } from '../provenance/HeatmapExtension'
import type { SaveStatus } from '../App'
import ProvenanceDebugPanel from './ProvenanceDebugPanel'
import YounessModal from './YounessModal'
import TimelineModal from './TimelineModal'
import './EditorPanel.css'

interface Props {
  documentId: string
  initialTitle: string
  initialContent: string
  onChange: (title: string, content: string) => void
  saveStatus: SaveStatus
  // Called once on mount with a function that accepts an AI suggestion.
  // The function returns true if the original text was found and replaced.
  onRegisterApplyEdit?: (fn: (original: string, suggested: string, editType: string) => boolean) => void
}

const SAVE_LABEL: Record<SaveStatus, string> = {
  saved: 'Saved',
  saving: 'Saving…',
  unsaved: 'Unsaved changes',
  error: 'Save failed',
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
  onChange,
  saveStatus,
  onRegisterApplyEdit,
}: Props) {
  const [title, setTitle] = useState(initialTitle)
  const [showDebug, setShowDebug] = useState(false)
  const [showYouness, setShowYouness] = useState(false)
  const [showTimeline, setShowTimeline] = useState(false)

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
      HeatmapExtension,
    ],
    content: parseContent(initialContent),
    onUpdate({ editor }) {
      onChangeRef.current(titleRef.current, JSON.stringify(editor.getJSON()))
    },
  })

  // Register the applyEdit function with the parent once the editor is ready.
  // We use useEffect so it runs after the editor is mounted (editor is non-null).
  useEffect(() => {
    if (!editor || !onRegisterApplyEdit) return

    // Finds `originalText` in the document by walking all text nodes and
    // building a flat character→position map. Then dispatches a replacement
    // transaction tagged with 'ai_suggestion' meta so ProvenanceExtension and
    // HeatmapExtension can record the correct authorship.
    function applyEdit(originalText: string, suggestedText: string, editType: string): boolean {
      const { state } = editor!
      const { doc, schema } = state

      // Build a flat array: for each character in text nodes, record its
      // absolute ProseMirror position. This lets us map a string-index match
      // back to document positions even across adjacent text nodes.
      const posMap: number[] = []
      let combined = ''
      doc.descendants((node, pos) => {
        if (node.isText && node.text) {
          for (let i = 0; i < node.text.length; i++) {
            posMap.push(pos + i)
            combined += node.text[i]
          }
        }
      })

      const idx = combined.indexOf(originalText)
      if (idx === -1) return false

      const from = posMap[idx]
      const to = posMap[idx + originalText.length - 1] + 1

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
        origin: 'ai_modified',
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

  // When the user switches to a different document, reload the editor content
  useEffect(() => {
    if (editor) {
      editor.commands.setContent(parseContent(initialContent))
      setTitle(initialTitle)
    }
    // Only run when documentId changes, not on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId])

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
          onClick={() => editor.chain().focus().toggleHeatmap().run()}
          className={heatmapKey.getState(editor.state)?.enabled ? 'active' : ''}
          title="Toggle heatmap view"
        >
          Heat
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

        <div className="toolbar-spacer" />

        <span className={`save-status save-status--${saveStatus}`}>
          {SAVE_LABEL[saveStatus]}
        </span>
      </div>

      <input
        className="document-title"
        value={title}
        onChange={handleTitleChange}
        placeholder="Untitled"
      />

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
