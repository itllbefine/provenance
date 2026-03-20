import { useCallback, useEffect, useRef, useState } from 'react'
import { createDocument, listDocuments, saveDocument } from './api'
import type { Document } from './api'
import EditorPanel from './components/EditorPanel'
import RationalePanel from './components/RationalePanel'
import SuggestionsPanel from './components/SuggestionsPanel'
import './App.css'

export type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'error'

export default function App() {
  const [doc, setDoc] = useState<Document | null>(null)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved')
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  if (!doc) {
    return <div className="loading">Loading…</div>
  }

  return (
    <div className="app-layout">
      <div className="left-panel">
        <div className="left-top">
          <SuggestionsPanel />
        </div>
        <div className="left-bottom">
          <RationalePanel />
        </div>
      </div>
      <div className="right-panel">
        <EditorPanel
          documentId={doc.id}
          initialTitle={doc.title}
          initialContent={doc.content}
          onChange={handleChange}
          saveStatus={saveStatus}
        />
      </div>
    </div>
  )
}
