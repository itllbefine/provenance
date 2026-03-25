// All requests go to /api/*, which Vite proxies to http://localhost:8000
const BASE = '/api'

export interface Document {
  id: string
  title: string
  content: string
  context: string
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
  origin: 'human' | 'human_edit' | 'ai_generated' | 'ai_modified' | 'ai_influenced' | 'ai_collaborative'
  edit_type: string | null
}

export interface Suggestion {
  id: string
  original_text: string
  suggested_text: string
  rationale: string
  edit_type: 'grammar_fix' | 'wording_change' | 'organizational_move' | 'observation'
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

export async function generateSuggestions(documentId: string, model = 'claude-sonnet-4-6'): Promise<Suggestion[]> {
  const res = await fetch(`${BASE}/suggestions/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ document_id: documentId, model }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail ?? `Request failed: ${res.statusText}`)
  }
  return res.json() as Promise<Suggestion[]>
}

// ── You-ness scoring ──────────────────────────────────────────────────────────

export interface StyleSample {
  id: string
  filename: string
  uploaded_at: string
  char_count: number
}

export interface YounessScore {
  score: number        // 0–100
  explanation: string  // plain-English explanation from Claude
  human_pct: number    // % of inserted text from human edits
  ai_pct: number       // % of inserted text from AI edits
  sample_count: number // number of baseline samples used
}

export async function uploadStyleSample(file: File): Promise<StyleSample> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${BASE}/youness/samples`, { method: 'POST', body: form })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail ?? `Upload failed: ${res.statusText}`)
  }
  return res.json() as Promise<StyleSample>
}

export async function listStyleSamples(): Promise<StyleSample[]> {
  const res = await fetch(`${BASE}/youness/samples`)
  if (!res.ok) throw new Error(`Failed to list samples: ${res.statusText}`)
  return res.json() as Promise<StyleSample[]>
}

export async function deleteStyleSample(id: string): Promise<void> {
  const res = await fetch(`${BASE}/youness/samples/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`Failed to delete sample: ${res.statusText}`)
}

export async function getYounessScore(docId: string): Promise<YounessScore> {
  const res = await fetch(`${BASE}/youness/score/${docId}`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail ?? `Scoring failed: ${res.statusText}`)
  }
  return res.json() as Promise<YounessScore>
}

// ── Timeline snapshots ────────────────────────────────────────────────────────

export interface TimelineSpan {
  text: string
  origin: string        // 'human' | 'ai_generated' | 'ai_modified' | 'boundary'
  edit_type: string | null
}

export interface TimelineMilestone {
  id: string | null     // snapshot DB id (null for live "Current")
  label: string         // "Suggest 1", "Snapshot — …", or "Current"
  event_count: number
  timestamp: string     // ISO 8601
  spans: TimelineSpan[]
}

export interface TimelineResponse {
  milestones: TimelineMilestone[]
}

export async function getHeatmapSpans(docId: string): Promise<TimelineSpan[]> {
  const res = await fetch(`${BASE}/timeline/${docId}/heatmap`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail ?? `Failed to load heatmap: ${res.statusText}`)
  }
  return res.json() as Promise<TimelineSpan[]>
}

export async function createManualSnapshot(docId: string): Promise<void> {
  const res = await fetch(`${BASE}/timeline/${docId}/snapshot`, { method: 'POST' })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail ?? `Failed to create snapshot: ${res.statusText}`)
  }
}

export async function deleteSnapshot(snapshotId: string): Promise<void> {
  const res = await fetch(`${BASE}/timeline/snapshot/${snapshotId}`, { method: 'DELETE' })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail ?? `Failed to delete snapshot: ${res.statusText}`)
  }
}

export async function getTimeline(docId: string): Promise<TimelineResponse> {
  const res = await fetch(`${BASE}/timeline/${docId}`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail ?? `Failed to load timeline: ${res.statusText}`)
  }
  return res.json() as Promise<TimelineResponse>
}

// ── Chat ─────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface SuggestedEdit {
  original_text: string
  suggested_text: string
  edit_type: 'grammar_fix' | 'wording_change' | 'organizational_move'
  rationale: string
}

export interface ChatResponse {
  message: string
  suggested_edit: SuggestedEdit | null
}

export async function chatWithContext(
  documentId: string,
  contextText: string,
  messages: ChatMessage[],
  model = 'claude-sonnet-4-6',
): Promise<ChatResponse> {
  const res = await fetch(`${BASE}/suggestions/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      document_id: documentId,
      context_text: contextText,
      messages,
      model,
    }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail ?? `Request failed: ${res.statusText}`)
  }
  return res.json() as Promise<ChatResponse>
}

// ── Dismissed suggestions archive ────────────────────────────────────────────

export interface DismissedSuggestion {
  id: string
  document_id: string
  original_text: string
  suggested_text: string
  edit_type: string
  rationale: string
  dismissed_at: string
}

export async function listDismissed(documentId: string): Promise<DismissedSuggestion[]> {
  const res = await fetch(`${BASE}/dismissed/${documentId}`)
  if (!res.ok) throw new Error(`Failed to list dismissed: ${res.statusText}`)
  return res.json() as Promise<DismissedSuggestion[]>
}

export async function dismissSuggestion(
  documentId: string,
  originalText: string,
  suggestedText: string,
  editType: string,
  rationale: string,
): Promise<DismissedSuggestion> {
  const res = await fetch(`${BASE}/dismissed/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      document_id: documentId,
      original_text: originalText,
      suggested_text: suggestedText,
      edit_type: editType,
      rationale: rationale,
    }),
  })
  if (!res.ok) throw new Error(`Failed to dismiss suggestion: ${res.statusText}`)
  return res.json() as Promise<DismissedSuggestion>
}

export async function restoreDismissed(dismissedId: string): Promise<void> {
  const res = await fetch(`${BASE}/dismissed/${dismissedId}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`Failed to restore suggestion: ${res.statusText}`)
}

export async function saveDocument(
  id: string,
  title: string,
  content: string,
  context?: string,
): Promise<Document> {
  const res = await fetch(`${BASE}/documents/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, content, ...(context !== undefined && { context }) }),
  })
  if (!res.ok) throw new Error(`Failed to save document: ${res.statusText}`)
  return res.json() as Promise<Document>
}
