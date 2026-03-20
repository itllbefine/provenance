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
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved')
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Suggestion state
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)

  // EditorPanel registers its applyEdit function here so App can call it
  // when the user accepts a suggestion.
  const applyEditRef = useRef<((original: string, suggested: string, editType: string) => boolean) | null>(null)

  // On first render, load the most recent document or create a new one
  useEffect(() => {
    async function loadInitialDocument() {
      try {
        const docs = await listDocuments()
        if (docs.length > 0) {
          setDoc(docs[0])
        } else {
          const newDoc = await createDocument()
          setDoc(newDoc)
        }
      } catch (err) {
        console.error('Failed to load document:', err)
      }
    }
    loadInitialDocument()
  }, [])

  // Called by EditorPanel whenever the title or content changes.
  // Debounced: waits 1.5s after the last keystroke before saving.
  const handleChange = useCallback(
    (title: string, content: string) => {
      if (!doc) return

      // Update local state immediately so the UI feels responsive
      setDoc((prev) => (prev ? { ...prev, title, content } : prev))
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

  async function handleGenerate() {
    if (!doc || isGenerating) return
    setIsGenerating(true)
    setGenerateError(null)
    setSuggestions([])
    setFocusedIndex(null)
    try {
      const results = await generateSuggestions(doc.id)
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
            onGenerate={handleGenerate}
            onFocus={setFocusedIndex}
            onAccept={handleAccept}
            onDismiss={handleDismiss}
          />
        </div>
        <div className="left-bottom">
          <RationalePanel
            suggestion={focusedIndex !== null ? suggestions[focusedIndex] ?? null : null}
          />
        </div>
      </div>
      <div className="right-panel">
        <EditorPanel
          documentId={doc.id}
          initialTitle={doc.title}
          initialContent={doc.content}
          onChange={handleChange}
          saveStatus={saveStatus}
          onRegisterApplyEdit={(fn) => { applyEditRef.current = fn }}
        />
      </div>
    </div>
  )
}
