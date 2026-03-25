import { useCallback, useEffect, useRef, useState } from 'react'
import DiffMatchPatch from 'diff-match-patch'
import { createDocument, dismissSuggestion, generateSuggestions, listDismissed, listDocuments, restoreDismissed, saveDocument } from './api'
import type { DismissedSuggestion, Document, Suggestion } from './api'
import EditorPanel from './components/EditorPanel'
import RationalePanel from './components/RationalePanel'
import SuggestionsPanel from './components/SuggestionsPanel'
import './App.css'

export type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'error'

const dmp = new DiffMatchPatch()

/** Compute similarity ratio (0–1) between two strings using diff-match-patch Levenshtein. */
function similarity(a: string, b: string): number {
  if (a === b) return 1
  if (!a && !b) return 1
  if (!a || !b) return 0
  const diffs = dmp.diff_main(a, b)
  const levenshtein = dmp.diff_levenshtein(diffs)
  const maxLen = Math.max(a.length, b.length)
  return maxLen === 0 ? 1 : 1 - levenshtein / maxLen
}

/** Returns true if a suggestion is too similar to any dismissed suggestion. */
function isDuplicate(suggestion: Suggestion, dismissed: DismissedSuggestion[]): boolean {
  // Observations have no text to compare — never filter them
  if (suggestion.edit_type === 'observation') return false
  return dismissed.some(
    (d) =>
      similarity(suggestion.original_text, d.original_text) > 0.8 &&
      similarity(suggestion.suggested_text, d.suggested_text) > 0.8,
  )
}

export default function App() {
  const [doc, setDoc] = useState<Document | null>(null)
  const [allDocs, setAllDocs] = useState<Document[]>([])
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved')
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Suggestion state
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [suggestionModel, setSuggestionModel] = useState<'claude-sonnet-4-6' | 'claude-opus-4-6'>('claude-sonnet-4-6')
  // Persisted archive of dismissed suggestions — loaded from the DB on doc switch.
  const [archive, setArchive] = useState<DismissedSuggestion[]>([])

  // EditorPanel registers its applyEdit function here so App can call it
  // when the user accepts a suggestion.
  const applyEditRef = useRef<((original: string, suggested: string, editType: string, origin?: string) => boolean) | null>(null)
  // EditorPanel registers its flushEvents function so we can flush
  // pending provenance events before generating suggestions.
  const flushEventsRef = useRef<(() => Promise<void>) | null>(null)

  // Persisted editor selection — survives focus moving to the chat input.
  // Set by EditorPanel's onSelectionChange; cleared on send or doc switch.
  const [activeSelection, setActiveSelection] = useState<string | null>(null)

  // On first render, load all documents; open the most recent or create a new one
  useEffect(() => {
    async function loadInitialDocument() {
      try {
        const docs = await listDocuments()
        if (docs.length > 0) {
          setAllDocs(docs)
          setDoc(docs[0])
        } else {
          const newDoc = await createDocument()
          setAllDocs([newDoc])
          setDoc(newDoc)
        }
      } catch (err) {
        console.error('Failed to load document:', err)
      }
    }
    loadInitialDocument()
  }, [])

  async function handleNewDocument() {
    try {
      const newDoc = await createDocument()
      setAllDocs((prev) => [newDoc, ...prev])
      setDoc(newDoc)
      setSaveStatus('saved')
    } catch (err) {
      console.error('Failed to create document:', err)
    }
  }

  function handleSwitchDocument(target: Document) {
    if (target.id === doc?.id) return
    // Cancel any pending save for the current doc
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    setDoc(target)
    setSaveStatus('saved')
  }

  // Called by EditorPanel whenever the title or content changes.
  // Debounced: waits 1.5s after the last keystroke before saving.
  const handleChange = useCallback(
    (title: string, content: string) => {
      if (!doc) return

      // Update local state immediately so the UI feels responsive
      setDoc((prev) => (prev ? { ...prev, title, content } : prev))
      // Also keep the title in sync in the doc list
      setAllDocs((prev) => prev.map((d) => (d.id === doc.id ? { ...d, title } : d)))
      setSaveStatus('unsaved')

      // Cancel any pending save and schedule a new one
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(async () => {
        setSaveStatus('saving')
        try {
          const updated = await saveDocument(doc.id, title, content)
          setDoc(updated)
          setSaveStatus('saved')
        } catch (err) {
          console.error('Save failed:', err)
          setSaveStatus('error')
        }
      }, 1500)
    },
    [doc],
  )

  // Reset suggestion state and load archive when the user switches documents
  const docId = doc?.id
  useEffect(() => {
    setSuggestions([])
    setFocusedIndex(null)
    setGenerateError(null)
    setActiveSelection(null)
    setArchive([])
    if (docId) {
      listDismissed(docId).then(setArchive).catch(() => setArchive([]))
    }
  }, [docId])

  // Debounced context save — separate from the title/content save so they
  // don't interfere with each other.
  const contextTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function handleContextChange(context: string) {
    if (!doc) return
    setDoc((prev) => (prev ? { ...prev, context } : prev))
    if (contextTimerRef.current) clearTimeout(contextTimerRef.current)
    contextTimerRef.current = setTimeout(async () => {
      try {
        const updated = await saveDocument(doc.id, doc.title, doc.content, context)
        setDoc(updated)
      } catch (err) {
        console.error('Context save failed:', err)
      }
    }, 1000)
  }

  async function handleGenerate() {
    if (!doc || isGenerating) return
    setIsGenerating(true)
    setGenerateError(null)
    setSuggestions([])
    setFocusedIndex(null)
    try {
      // Flush pending provenance events so the snapshot is complete.
      await flushEventsRef.current?.()
      const raw = await generateSuggestions(doc.id, suggestionModel)
      // Client-side filtering: suppress suggestions that are too similar to archived ones.
      const results = raw.filter((s) => !isDuplicate(s, archive))
      setSuggestions(results)
      if (results.length > 0) setFocusedIndex(0)
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : 'Failed to generate suggestions')
    } finally {
      setIsGenerating(false)
    }
  }

  function handleAccept(index: number) {
    const suggestion = suggestions[index]
    if (!suggestion || !applyEditRef.current) return

    const applied = applyEditRef.current(
      suggestion.original_text,
      suggestion.suggested_text,
      suggestion.edit_type,
    )

    if (!applied) {
      // Text not found — the document may have changed since suggestions were generated
      setGenerateError(
        `Could not find "${suggestion.original_text.slice(0, 40)}…" in the document. ` +
        'The document may have changed since suggestions were generated.',
      )
    }

    // Remove the accepted suggestion regardless of whether it applied
    removeSuggestion(index)
  }

  function handleDismiss(index: number) {
    const suggestion = suggestions[index]
    if (!suggestion || !doc) { removeSuggestion(index); return }
    // Persist the dismissal to the database (observations included for archive viewing)
    dismissSuggestion(
      doc.id,
      suggestion.original_text,
      suggestion.suggested_text,
      suggestion.edit_type,
      suggestion.rationale,
    )
      .then((dismissed) => setArchive((prev) => [dismissed, ...prev]))
      .catch((err) => console.error('Failed to archive dismissal:', err))
    removeSuggestion(index)
  }

  function handleRestore(dismissedId: string) {
    restoreDismissed(dismissedId)
      .then(() => setArchive((prev) => prev.filter((d) => d.id !== dismissedId)))
      .catch((err) => console.error('Failed to restore suggestion:', err))
  }

  function removeSuggestion(index: number) {
    setSuggestions((prev) => {
      const next = prev.filter((_, i) => i !== index)
      // Keep focus on the same position, or move back if we were at the end
      setFocusedIndex(next.length === 0 ? null : Math.min(index, next.length - 1))
      return next
    })
  }

  if (!doc) {
    return <div className="loading">Loading…</div>
  }

  return (
    <div className="app-layout">
      <div className="left-panel">
        <div className="left-top">
          <SuggestionsPanel
            suggestions={suggestions}
            focusedIndex={focusedIndex}
            isGenerating={isGenerating}
            generateError={generateError}
            model={suggestionModel}
            onModelChange={setSuggestionModel}
            onGenerate={handleGenerate}
            onFocus={setFocusedIndex}
            onAccept={handleAccept}
            onDismiss={handleDismiss}
            archive={archive}
            onRestore={handleRestore}
          />
        </div>
        <div className="left-bottom">
          <RationalePanel
            suggestion={focusedIndex !== null ? suggestions[focusedIndex] ?? null : null}
            documentId={doc.id}
            suggestionModel={suggestionModel}
            activeSelection={activeSelection}
            onClearSelection={() => setActiveSelection(null)}
            onAcceptChatEdit={(original, suggested, editType) => {
              const applied = applyEditRef.current?.(original, suggested, editType, 'ai_collaborative')
              if (!applied) {
                setGenerateError(
                  `Could not find "${original.slice(0, 40)}…" in the document. ` +
                  'The document may have changed.',
                )
              }
              return !!applied
            }}
          />
        </div>
      </div>
      <div className="right-panel">
        <EditorPanel
          documentId={doc.id}
          initialTitle={doc.title}
          initialContent={doc.content}
          initialContext={doc.context}
          allDocs={allDocs}
          onNewDocument={() => void handleNewDocument()}
          onSwitchDocument={handleSwitchDocument}
          onChange={handleChange}
          onContextChange={handleContextChange}
          saveStatus={saveStatus}
          onRegisterApplyEdit={(fn) => { applyEditRef.current = fn }}
          onRegisterFlushEvents={(fn) => { flushEventsRef.current = fn }}
          onSelectionChange={setActiveSelection}
          getSuggestions={() => suggestions}
          archive={archive}
        />
      </div>
    </div>
  )
}

