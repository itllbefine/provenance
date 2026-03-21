import { useCallback, useEffect, useRef, useState } from 'react'
import { createDocument, generateSuggestions, listDocuments, saveDocument } from './api'
import type { Document, Suggestion } from './api'
import EditorPanel from './components/EditorPanel'
import RationalePanel from './components/RationalePanel'
import SuggestionsPanel from './components/SuggestionsPanel'
import './App.css'

export type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'error'

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
  // original_text values the user has dismissed — sent to the backend so Claude
  // won't re-suggest them. Reset when switching documents.
  const [dismissed, setDismissed] = useState<string[]>([])

  // EditorPanel registers its applyEdit function here so App can call it
  // when the user accepts a suggestion.
  const applyEditRef = useRef<((original: string, suggested: string, editType: string, origin?: string) => boolean) | null>(null)

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

  // Reset suggestion state when the user switches to a different document
  const docId = doc?.id
  useEffect(() => {
    setDismissed([])
    setSuggestions([])
    setFocusedIndex(null)
    setGenerateError(null)
    setActiveSelection(null)
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
      const results = await generateSuggestions(doc.id, dismissed, suggestionModel)
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
    // Observations have no original_text to track; only add dismissals for
    // specific edits so they don't pollute the dismissed list.
    if (suggestion?.original_text) {
      setDismissed((prev) => [...prev, suggestion.original_text])
    }
    removeSuggestion(index)
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
          onSelectionChange={setActiveSelection}
          getSuggestions={() => suggestions}
        />
      </div>
    </div>
  )
}

