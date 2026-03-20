import { useCallback, useEffect, useState } from 'react'
import type { ProvenanceEvent } from '../api'
import { getProvenanceEvents } from '../api'
import './ProvenanceDebugPanel.css'

interface Props {
  documentId: string
}

export default function ProvenanceDebugPanel({ documentId }: Props) {
  const [events, setEvents] = useState<ProvenanceEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await getProvenanceEvents(documentId)
      setEvents(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load events')
    } finally {
      setLoading(false)
    }
  }, [documentId])

  // Fetch on mount and whenever the document switches
  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="provenance-debug">
      <div className="provenance-debug__header">
        <span>Provenance Log ({events.length} events)</span>
        <button
          className="provenance-debug__refresh"
          onClick={load}
          disabled={loading}
          title="Refresh"
        >
          {loading ? '…' : '↻'}
        </button>
      </div>
      {error && <div className="provenance-debug__error">{error}</div>}
      <div className="provenance-debug__list">
        {events.length === 0 && !loading && (
          <div className="provenance-debug__empty">No events yet. Start typing.</div>
        )}
        {events.map((ev) => (
          <div key={ev.id} className={`provenance-debug__event provenance-debug__event--${ev.event_type}`}>
            <span className="provenance-debug__badge">{ev.event_type}</span>
            <span className="provenance-debug__pos">{ev.from_pos}–{ev.to_pos}</span>
            {ev.inserted_text && (
              <span className="provenance-debug__text provenance-debug__text--inserted">
                +{JSON.stringify(ev.inserted_text)}
              </span>
            )}
            {ev.deleted_text && (
              <span className="provenance-debug__text provenance-debug__text--deleted">
                −{JSON.stringify(ev.deleted_text)}
              </span>
            )}
            <span className="provenance-debug__time">
              {new Date(ev.timestamp).toLocaleTimeString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
