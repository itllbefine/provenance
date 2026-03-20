import { useEffect, useState } from 'react'
import type { TimelineMilestone, TimelineResponse, TimelineSpan } from '../api'
import { getTimeline } from '../api'
import './TimelineModal.css'

interface Props {
  documentId: string
  onClose: () => void
}

/**
 * Map a provenance (origin, edit_type) pair to a CSS background-color string.
 * Uses the same color palette as the heatmap decorations in EditorPanel.css.
 */
function spanBg(origin: string, editType: string | null): string {
  if (origin === 'boundary') return 'transparent'

  if (origin === 'human') {
    switch (editType) {
      case 'human_grammar_fix':         return 'rgba(34, 211, 238, 0.30)'
      case 'human_wording_change':      return 'rgba(74, 222, 128, 0.30)'
      case 'human_organizational_move': return 'rgba(96, 165, 250, 0.35)'
      default:                          return 'rgba(251, 191, 36, 0.25)'
    }
  }

  // AI origins
  switch (editType) {
    case 'grammar_fix':         return 'rgba(253, 224, 71, 0.45)'
    case 'wording_change':      return 'rgba(251, 146, 60, 0.35)'
    case 'organizational_move': return 'rgba(167, 139, 250, 0.40)'
    default:                    return 'rgba(251, 113, 133, 0.25)'
  }
}

/** Render a single span, replacing '\\n' with <br> for paragraph display. */
function SpanText({ span }: { span: TimelineSpan }) {
  const bg = spanBg(span.origin, span.edit_type)
  const lines = span.text.split('\n')

  return (
    <span style={{ backgroundColor: bg, borderRadius: '2px' }}>
      {lines.map((line, i) => (
        <span key={i}>
          {line}
          {i < lines.length - 1 && <br />}
        </span>
      ))}
    </span>
  )
}

/** Format an ISO timestamp as "Jan 5, 2:32 PM". */
function fmtTimestamp(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function MilestoneSnapshot({ milestone }: { milestone: TimelineMilestone }) {
  return (
    <div className="tl-snapshot">
      <div className="tl-snapshot-header">
        <span className="tl-snapshot-pct">
          {Math.round(milestone.milestone * 100)}%
        </span>
        <span className="tl-snapshot-meta">
          {milestone.event_count} edit{milestone.event_count !== 1 ? 's' : ''}
        </span>
        <span className="tl-snapshot-meta">{fmtTimestamp(milestone.timestamp)}</span>
      </div>
      <div className="tl-snapshot-body">
        {milestone.spans.map((span, i) => (
          <SpanText key={i} span={span} />
        ))}
      </div>
    </div>
  )
}

export default function TimelineModal({ documentId, onClose }: Props) {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<TimelineResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getTimeline(documentId)
      .then(setData)
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'Failed to load timeline.'),
      )
      .finally(() => setLoading(false))
  }, [documentId])

  return (
    // Clicking the overlay (outside the card) closes the modal
    <div className="tl-overlay" onClick={onClose}>
      {/* stopPropagation prevents clicks inside the card from closing the modal */}
      <div className="tl-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tl-header">
          <h2 className="tl-title">Document Timeline</h2>
          <button className="tl-close" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        <div className="tl-body">
          {loading && <p className="tl-hint">Loading…</p>}
          {error && <p className="tl-error">{error}</p>}

          {data && data.milestones.length === 0 && (
            <p className="tl-hint">
              No edits recorded yet. Start writing to see your timeline.
            </p>
          )}

          {data && data.milestones.length > 0 && (
            <div className="tl-grid">
              {data.milestones.map((m) => (
                <MilestoneSnapshot key={m.milestone} milestone={m} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
