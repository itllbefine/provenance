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

  // Original first-draft human typing — no highlight
  if (origin === 'human') return 'transparent'

  if (origin === 'human_edit') {
    switch (editType) {
      case 'human_grammar_fix':         return 'rgba(34, 211, 238, 0.30)'
      case 'human_wording_change':      return 'rgba(74, 222, 128, 0.30)'
      case 'human_organizational_move': return 'rgba(96, 165, 250, 0.35)'
      default:                          return 'rgba(251, 191, 36, 0.25)'
    }
  }

  // AI origins
  switch (editType) {
    case 'grammar_fix':         return 'rgba(34, 211, 238, 0.30)'
    case 'wording_change':      return 'rgba(74, 222, 128, 0.30)'
    case 'organizational_move': return 'rgba(96, 165, 250, 0.35)'
    default:                    return 'rgba(251, 191, 36, 0.25)'
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

/**
 * Build an off-screen DOM card for a milestone and capture it as a canvas.
 *
 * For milestones below 100%, `filter: blur(4px)` is applied to the text body.
 * The span background colors (heatmap) remain visible as colored blobs, showing
 * the authorship pattern without revealing the actual text content.
 */
async function captureCard(
  milestone: TimelineMilestone,
  html2canvas: (el: HTMLElement, opts?: object) => Promise<HTMLCanvasElement>,
): Promise<HTMLCanvasElement> {
  const pct = Math.round(milestone.milestone * 100)
  const blurred = pct < 100

  // Off-screen wrapper — placed far off-screen so it doesn't flash
  const wrapper = document.createElement('div')
  wrapper.style.cssText = 'position:fixed;left:-9999px;top:0;'
  document.body.appendChild(wrapper)

  try {
    // Card shell
    const card = document.createElement('div')
    card.style.cssText =
      'width:420px;background:#fff;border:1px solid #e8e5e0;border-radius:6px;overflow:hidden;'

    // Header
    const header = document.createElement('div')
    header.style.cssText =
      'background:#fafaf8;border-bottom:1px solid #e8e5e0;padding:12px 14px;'
    const pctEl = document.createElement('div')
    pctEl.style.cssText = 'font-size:18px;font-weight:700;color:#1a1a18;margin-bottom:4px;'
    pctEl.textContent = `${pct}%`
    const metaEl = document.createElement('div')
    metaEl.style.cssText = 'font-size:12px;color:#aaa;'
    metaEl.textContent = `${milestone.event_count} edit${milestone.event_count !== 1 ? 's' : ''} · ${fmtTimestamp(milestone.timestamp)}`
    header.appendChild(pctEl)
    header.appendChild(metaEl)

    // Body — spans with heatmap background colors
    const body = document.createElement('div')
    body.style.cssText = [
      'padding:14px;',
      "font-size:12px;font-family:Georgia,'Times New Roman',serif;",
      'line-height:1.75;color:#1a1a18;word-break:break-word;',
      blurred ? 'filter:blur(4px);' : '',
    ].join('')

    for (const span of milestone.spans) {
      const bg = spanBg(span.origin, span.edit_type)
      const spanEl = document.createElement('span')
      spanEl.style.cssText = `background-color:${bg};border-radius:2px;`
      // Preserve line breaks
      const lines = span.text.split('\n')
      lines.forEach((line, i) => {
        spanEl.appendChild(document.createTextNode(line))
        if (i < lines.length - 1) spanEl.appendChild(document.createElement('br'))
      })
      body.appendChild(spanEl)
    }

    card.appendChild(header)
    card.appendChild(body)
    wrapper.appendChild(card)

    return await html2canvas(card, { scale: 2, backgroundColor: '#ffffff' })
  } finally {
    document.body.removeChild(wrapper)
  }
}

/** Trigger a PNG download from a canvas element. */
function downloadPng(canvas: HTMLCanvasElement, filename: string) {
  const link = document.createElement('a')
  link.download = filename
  link.href = canvas.toDataURL('image/png')
  link.click()
}

/**
 * Export all milestones:
 * - 25 / 50 / 75 % → individual PNG files with blurred text
 * - 100 %          → PDF with readable text
 */
async function exportTimeline(data: TimelineResponse): Promise<void> {
  // Dynamic imports so these large libs don't bloat the initial bundle
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
    import('html2canvas'),
    import('jspdf'),
  ])

  for (const milestone of data.milestones) {
    const pct = Math.round(milestone.milestone * 100)
    const canvas = await captureCard(milestone, html2canvas)

    if (pct < 100) {
      downloadPng(canvas, `timeline-${pct}pct.png`)
    } else {
      // Scale canvas pixels back to CSS px (we rendered at scale:2)
      const w = canvas.width / 2
      const h = canvas.height / 2
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'px', format: [w, h] })
      pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, w, h)
      pdf.save('timeline-100pct.pdf')
    }
  }
}

const LEGEND: { group: string; items: { label: string; color: string }[] }[] = [
  {
    group: 'AI',
    items: [
      { label: 'Grammar fix',   color: 'rgba(34, 211, 238, 0.55)' },
      { label: 'Wording',       color: 'rgba(74, 222, 128, 0.55)' },
      { label: 'Reorganized',   color: 'rgba(96, 165, 250, 0.60)' },
      { label: 'Generated',     color: 'rgba(251, 191, 36, 0.50)' },
    ],
  },
]

function ColorKey() {
  return (
    <div className="tl-legend">
      {LEGEND.map((group) => (
        <div key={group.group} className="tl-legend-group">
          <span className="tl-legend-group-label">{group.group}</span>
          {group.items.map((item) => (
            <span key={item.label} className="tl-legend-item">
              <span className="tl-legend-swatch" style={{ background: item.color }} />
              {item.label}
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}

export default function TimelineModal({ documentId, onClose }: Props) {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<TimelineResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  useEffect(() => {
    getTimeline(documentId)
      .then(setData)
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'Failed to load timeline.'),
      )
      .finally(() => setLoading(false))
  }, [documentId])

  async function handleExport() {
    if (!data || exporting) return
    setExporting(true)
    setExportError(null)
    try {
      await exportTimeline(data)
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Export failed.')
    } finally {
      setExporting(false)
    }
  }

  const canExport = !!data && data.milestones.length > 0 && !exporting

  return (
    // Clicking the overlay (outside the card) closes the modal
    <div className="tl-overlay" onClick={onClose}>
      {/* stopPropagation prevents clicks inside the card from closing the modal */}
      <div className="tl-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tl-header">
          <h2 className="tl-title">Document Timeline</h2>

          <button
            className="tl-export"
            onClick={handleExport}
            disabled={!canExport}
            title={
              exporting
                ? 'Generating export…'
                : 'Export snapshots (PNG + PDF)'
            }
          >
            {exporting ? 'Exporting…' : 'Export'}
          </button>

          <button className="tl-close" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        {exportError && <p className="tl-export-error">{exportError}</p>}

        <ColorKey />

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
