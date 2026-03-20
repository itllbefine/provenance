// All requests go to /api/*, which Vite proxies to http://localhost:8000
const BASE = '/api'

export interface Document {
  id: string
  title: string
  content: string
  created_at: string
  updated_at: string
}

export async function listDocuments(): Promise<Document[]> {
  const res = await fetch(`${BASE}/documents/`)
  if (!res.ok) throw new Error(`Failed to list documents: ${res.statusText}`)
  return res.json() as Promise<Document[]>
}

export async function createDocument(title = 'Untitled'): Promise<Document> {
  const res = await fetch(`${BASE}/documents/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  if (!res.ok) throw new Error(`Failed to create document: ${res.statusText}`)
  return res.json() as Promise<Document>
}

export interface ProvenanceEvent {
  id: string
  document_id: string
  event_type: 'insert' | 'delete' | 'replace'
  from_pos: number
  to_pos: number
  inserted_text: string
  deleted_text: string
  author: string
  timestamp: string
}

export interface RawProvenanceEvent {
  event_type: 'insert' | 'delete' | 'replace'
  from_pos: number
  to_pos: number
  inserted_text: string
  deleted_text: string
  author: string
  timestamp: string
  origin: 'human' | 'ai_generated' | 'ai_modified'
  edit_type: string | null
}

export interface Suggestion {
  id: string
  original_text: string
  suggested_text: string
  rationale: string
  edit_type: 'grammar_fix' | 'wording_change' | 'organizational_move'
}

export async function flushProvenanceEvents(
  documentId: string,
  events: RawProvenanceEvent[],
): Promise<void> {
  if (events.length === 0) return
  const res = await fetch(`${BASE}/provenance/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ document_id: documentId, events }),
  })
  if (!res.ok) throw new Error(`Failed to save provenance events: ${res.statusText}`)
}

export async function getProvenanceEvents(docId: string): Promise<ProvenanceEvent[]> {
  const res = await fetch(`${BASE}/provenance/events/${docId}`)
  if (!res.ok) throw new Error(`Failed to load provenance events: ${res.statusText}`)
  return res.json() as Promise<ProvenanceEvent[]>
}

export async function generateSuggestions(documentId: string): Promise<Suggestion[]> {
  const res = await fetch(`${BASE}/suggestions/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ document_id: documentId }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail ?? `Request failed: ${res.statusText}`)
  }
  return res.json() as Promise<Suggestion[]>
}

export async function saveDocument(
  id: string,
  title: string,
  content: string,
): Promise<Document> {
  const res = await fetch(`${BASE}/documents/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, content }),
  })
  if (!res.ok) throw new Error(`Failed to save document: ${res.statusText}`)
  return res.json() as Promise<Document>
}
