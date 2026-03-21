import { useEffect, useState } from 'react'
import type { TimelineMilestone, TimelineResponse, TimelineSpan } from '../api'
import { getTimeline, deleteSnapshot } from '../api'
import './TimelineModal.css'

interface Props {
  documentId: string
  onClose: () => void
}

// -- Shared color definitions -------------------------------------------------

// Legend items used in the UI, PNG, and PDF color keys.
const LEGEND_ITEMS: { label: string; cssColor: string; rgb: [number, number, number] }[] = [
  { label: 'Grammar fix', cssColor: 'rgba(34, 211, 238, 0.55)', rgb: [34, 211, 238] },
  { label: 'Wording',     cssColor: 'rgba(74, 222, 128, 0.55)', rgb: [74, 222, 128] },
  { label: 'Reorganized', cssColor: 'rgba(96, 165, 250, 0.60)', rgb: [96, 165, 250] },
  { label: 'Generated',   cssColor: 'rgba(251, 191, 36, 0.50)', rgb: [251, 191, 36] },
]

// Map edit_type to legend index (for shared lookup)
const EDIT_TYPE_INDEX: Record<string, number> = {
  grammar_fix: 0,
  wording_change: 1,
  organizational_move: 2,
}

/**
 * Map a provenance (origin, edit_type) pair to a CSS background-color string.
 */
function spanBg(origin: string, editType: string | null): string {
  if (origin === 'boundary') return 'transparent'
  if (origin === 'human' || origin === 'human_edit') return 'transparent'

  const idx = editType ? EDIT_TYPE_INDEX[editType] : undefined
  if (idx !== undefined) return LEGEND_ITEMS[idx].cssColor
  // Default: "Generated" (amber)
  return LEGEND_ITEMS[3].cssColor
}

/**
 * Return an RGB triple blended against white at the given alpha,
 * or null if the span should have no background.
 */
function spanPdfBg(origin: string, editType: string | null): [number, number, number] | null {
  if (origin === 'boundary' || origin === 'human' || origin === 'human_edit') return null

  const idx = editType ? EDIT_TYPE_INDEX[editType] : undefined
  const [r, g, b] = idx !== undefined ? LEGEND_ITEMS[idx].rgb : LEGEND_ITEMS[3].rgb

  // Blend against white at ~0.30 alpha so the background is a subtle tint
  const a = 0.30
  return [
    Math.round(255 * (1 - a) + r * a),
    Math.round(255 * (1 - a) + g * a),
    Math.round(255 * (1 - a) + b * a),
  ]
}

// -- UI components ------------------------------------------------------------

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

function fmtTimestamp(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function MilestoneSnapshot({
  milestone,
  onDelete,
}: {
  milestone: TimelineMilestone
  onDelete?: (id: string) => void
}) {
  const isCurrent = milestone.label === 'Current'
  return (
    <div className="tl-snapshot">
      <div className="tl-snapshot-header">
        <div className="tl-snapshot-header-top">
          <span className="tl-snapshot-pct">{milestone.label}</span>
          {!isCurrent && milestone.id && onDelete && (
            <button
              className="tl-snapshot-delete"
              onClick={() => onDelete(milestone.id!)}
              title="Delete this snapshot"
            >
              ✕
            </button>
          )}
        </div>
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

function ColorKey() {
  return (
    <div className="tl-legend">
      <div className="tl-legend-group">
        <span className="tl-legend-group-label">AI</span>
        {LEGEND_ITEMS.map((item) => (
          <span key={item.label} className="tl-legend-item">
            <span className="tl-legend-swatch" style={{ background: item.cssColor }} />
            {item.label}
          </span>
        ))}
      </div>
    </div>
  )
}

// -- PNG export: thumbnail grid with html2canvas ------------------------------

async function captureCard(
  milestone: TimelineMilestone,
  html2canvas: (el: HTMLElement, opts?: object) => Promise<HTMLCanvasElement>,
  cardWidth: number,
  fontSize: number,
): Promise<HTMLCanvasElement> {
  const wrapper = document.createElement('div')
  wrapper.style.cssText = 'position:fixed;left:-9999px;top:0;'
  document.body.appendChild(wrapper)

  try {
    const card = document.createElement('div')
    card.style.cssText =
      `width:${cardWidth}px;background:#fff;border:1px solid #e8e5e0;border-radius:6px;overflow:hidden;`

    const hdrFont = Math.max(7, fontSize * 1.4)
    const hdrPad = Math.max(4, fontSize * 0.8)
    const header = document.createElement('div')
    header.style.cssText =
      `background:#fafaf8;border-bottom:1px solid #e8e5e0;padding:${hdrPad}px ${hdrPad + 2}px;`
    const labelEl = document.createElement('div')
    labelEl.style.cssText = `font-size:${hdrFont}px;font-weight:700;color:#1a1a18;margin-bottom:1px;`
    labelEl.textContent = milestone.label
    const metaEl = document.createElement('div')
    metaEl.style.cssText = `font-size:${Math.max(5, fontSize * 0.9)}px;color:#aaa;`
    metaEl.textContent = `${milestone.event_count} edit${milestone.event_count !== 1 ? 's' : ''} · ${fmtTimestamp(milestone.timestamp)}`
    header.appendChild(labelEl)
    header.appendChild(metaEl)

    const bodyPad = Math.max(4, fontSize * 0.8)
    const body = document.createElement('div')
    body.style.cssText = [
      `padding:${bodyPad}px;`,
      `font-size:${fontSize}px;font-family:Georgia,'Times New Roman',serif;`,
      'line-height:1.5;color:#1a1a18;word-break:break-word;',
    ].join('')

    for (const span of milestone.spans) {
      const bg = spanBg(span.origin, span.edit_type)
      const spanEl = document.createElement('span')
      spanEl.style.cssText = `background-color:${bg};border-radius:2px;`
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

function blurCanvas(source: HTMLCanvasElement, radius: number): HTMLCanvasElement {
  const out = document.createElement('canvas')
  out.width = source.width
  out.height = source.height
  const ctx = out.getContext('2d')!
  ctx.filter = `blur(${radius}px)`
  ctx.drawImage(source, 0, 0)
  return out
}

function downloadDataUrl(dataUrl: string, filename: string) {
  const link = document.createElement('a')
  link.download = filename
  link.href = dataUrl
  link.click()
}

/** Draw the color key legend onto a canvas at the given position. Returns the height used. */
function drawCanvasLegend(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number): number {
  const s = scale
  const swatchW = 10 * s
  const swatchH = 10 * s
  const itemGap = 12 * s
  const textOffset = swatchW + 4 * s

  ctx.font = `bold ${9 * s}px sans-serif`
  ctx.fillStyle = '#888'
  ctx.fillText('AI', x, y + swatchH)
  let cx = x + ctx.measureText('AI').width + 8 * s

  ctx.font = `${8 * s}px sans-serif`
  for (const item of LEGEND_ITEMS) {
    const [r, g, b] = item.rgb
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.55)`
    ctx.fillRect(cx, y, swatchW, swatchH)
    ctx.fillStyle = '#666'
    ctx.fillText(item.label, cx + textOffset, y + swatchH - 1 * s)
    cx += textOffset + ctx.measureText(item.label).width + itemGap
  }

  return swatchH + 6 * s
}

// -- PDF export: real selectable text with jsPDF ------------------------------

type JsPDF = InstanceType<typeof import('jspdf').jsPDF>

/** Draw the color key legend onto a PDF page. Returns the y position after the legend. */
function drawPdfLegend(pdf: JsPDF, margin: number, y: number): number {
  const swatchW = 8
  const swatchH = 6
  const itemGap = 8

  pdf.setFont('helvetica', 'bold')
  pdf.setFontSize(8)
  pdf.setTextColor(136, 136, 136)
  pdf.text('AI', margin, y + swatchH - 1)
  let cx = margin + pdf.getTextWidth('AI') + 6

  pdf.setFont('helvetica', 'normal')
  pdf.setFontSize(7)
  for (const item of LEGEND_ITEMS) {
    // Blend RGB against white at 0.30 for a visible swatch
    const a = 0.30
    const r = Math.round(255 * (1 - a) + item.rgb[0] * a)
    const g = Math.round(255 * (1 - a) + item.rgb[1] * a)
    const b = Math.round(255 * (1 - a) + item.rgb[2] * a)
    pdf.setFillColor(r, g, b)
    pdf.rect(cx, y, swatchW, swatchH, 'F')
    pdf.setTextColor(102, 102, 102)
    pdf.text(item.label, cx + swatchW + 3, y + swatchH - 1)
    cx += swatchW + 3 + pdf.getTextWidth(item.label) + itemGap
  }

  return y + swatchH + 8
}

/**
 * Render provenance-tagged spans into a jsPDF document as real selectable text.
 *
 * Uses a two-pass approach: first compute the layout (page, x, y, width) for
 * every token, then draw all background rects (merged into continuous runs),
 * and finally draw all text on top. This ensures highlights are seamless and
 * text is always readable above the background.
 */
function renderSpansToPdf(
  pdf: JsPDF,
  spans: TimelineSpan[],
  label: string,
  timestamp: string,
  eventCount: number,
): void {
  const pageW = pdf.internal.pageSize.getWidth()
  const pageH = pdf.internal.pageSize.getHeight()
  const margin = 40
  const maxX = pageW - margin
  const bodyFontSize = 11
  const lineH = bodyFontSize * 1.5
  const ascent = bodyFontSize * 0.8

  // --- Header (page 1) ---
  pdf.setFont('times', 'bold')
  pdf.setFontSize(16)
  pdf.setTextColor(26, 26, 24)
  pdf.text(label, margin, margin + 16)

  pdf.setFont('times', 'normal')
  pdf.setFontSize(9)
  pdf.setTextColor(160, 160, 160)
  pdf.text(
    `${eventCount} edit${eventCount !== 1 ? 's' : ''} · ${fmtTimestamp(timestamp)}`,
    margin,
    margin + 28,
  )

  let startY = drawPdfLegend(pdf, margin, margin + 38)
  pdf.setDrawColor(220, 220, 220)
  pdf.line(margin, startY, pageW - margin, startY)
  startY += 12

  // --- Tokenize spans ---
  type Token = { text: string; bg: [number, number, number] | null; paraBreak?: boolean }
  const tokens: Token[] = []

  for (const span of spans) {
    if (span.origin === 'boundary') continue
    const bg = spanPdfBg(span.origin, span.edit_type)
    const segments = span.text.split('\n')
    for (let si = 0; si < segments.length; si++) {
      if (si > 0) tokens.push({ text: '', bg: null, paraBreak: true })
      const segment = segments[si]
      if (!segment) continue
      const parts = segment.match(/\S+|\s+/g) || []
      for (const part of parts) {
        tokens.push({ text: part, bg })
      }
    }
  }

  // --- Pass 1: compute layout positions ---
  type Placed = { page: number; x: number; y: number; w: number; text: string; bg: [number, number, number] | null }
  const placed: Placed[] = []
  let page = 1
  let x = margin
  let y = startY
  // Track which pages need a legend header (page 1 already has one)
  const pageHeaderY: Map<number, number> = new Map()
  pageHeaderY.set(1, startY)

  pdf.setFont('times', 'normal')
  pdf.setFontSize(bodyFontSize)

  for (const token of tokens) {
    if (token.paraBreak) {
      x = margin
      y += lineH * 1.2
      if (y > pageH - margin) {
        page++
        pdf.addPage()
        y = margin
        y = drawPdfLegend(pdf, margin, y)
        pdf.setDrawColor(220, 220, 220)
        pdf.line(margin, y, pageW - margin, y)
        y += 12
        pageHeaderY.set(page, y)
        pdf.setFont('times', 'normal')
        pdf.setFontSize(bodyFontSize)
      }
      x = margin
      continue
    }

    pdf.setFont('times', 'normal')
    pdf.setFontSize(bodyFontSize)
    const w = pdf.getTextWidth(token.text)

    if (x + w > maxX && x > margin) {
      if (token.text.trim() === '') continue
      x = margin
      y += lineH
      if (y > pageH - margin) {
        page++
        pdf.addPage()
        y = margin
        y = drawPdfLegend(pdf, margin, y)
        pdf.setDrawColor(220, 220, 220)
        pdf.line(margin, y, pageW - margin, y)
        y += 12
        pageHeaderY.set(page, y)
        pdf.setFont('times', 'normal')
        pdf.setFontSize(bodyFontSize)
      }
    }

    placed.push({ page, x, y, w, text: token.text, bg: token.bg })
    x += w
  }

  const totalPages = page

  // --- Pass 2: draw background rects (merged into continuous runs) ---
  // A "run" is a contiguous stretch on the same line with the same bg color.
  // We track the run's start x and extend it as long as bg + line match,
  // then draw one rect when the run breaks.
  for (let p = 1; p <= totalPages; p++) {
    pdf.setPage(p)
    const pageItems = placed.filter((it) => it.page === p)

    let runBg: [number, number, number] | null = null
    let runStartX = 0
    let runEndX = 0
    let runY = 0

    for (const item of pageItems) {
      const colorMatch =
        runBg !== null && item.bg !== null &&
        runBg[0] === item.bg[0] && runBg[1] === item.bg[1] && runBg[2] === item.bg[2]
      const sameLine = runY === item.y

      if (colorMatch && sameLine) {
        // Extend the current run
        runEndX = item.x + item.w
      } else {
        // Flush previous run
        if (runBg) {
          pdf.setFillColor(runBg[0], runBg[1], runBg[2])
          pdf.rect(runStartX, runY - ascent, runEndX - runStartX, lineH, 'F')
        }
        // Start new run (or clear if no bg)
        if (item.bg) {
          runBg = item.bg
          runStartX = item.x
          runEndX = item.x + item.w
          runY = item.y
        } else {
          runBg = null
        }
      }
    }
    // Flush final run on this page
    if (runBg) {
      pdf.setFillColor(runBg[0], runBg[1], runBg[2])
      pdf.rect(runStartX, runY - ascent, runEndX - runStartX, lineH, 'F')
    }
  }

  // --- Pass 3: draw text ---
  for (let p = 1; p <= totalPages; p++) {
    pdf.setPage(p)
    pdf.setFont('times', 'normal')
    pdf.setFontSize(bodyFontSize)
    pdf.setTextColor(26, 26, 24)
    const pageItems = placed.filter((it) => it.page === p)
    for (const item of pageItems) {
      pdf.text(item.text, item.x, item.y)
    }
  }
}

// -- Main export function -----------------------------------------------------

const TARGET_W = 900
const MIN_CARD_W = 100
const PNG_GAP = 10
const PNG_PAD = 16

async function exportTimeline(data: TimelineResponse): Promise<void> {
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
    import('html2canvas'),
    import('jspdf'),
  ])

  const n = data.milestones.length
  if (n === 0) return

  // --- PNG: thumbnail grid ---
  const maxColsForWidth = Math.floor((TARGET_W + PNG_GAP) / (MIN_CARD_W + PNG_GAP))
  const cols = Math.min(n, maxColsForWidth)
  const cardW = Math.floor((TARGET_W - PNG_PAD * 2 - (cols - 1) * PNG_GAP) / cols)
  const fontSize = Math.max(4, Math.min(9, cardW / 30))

  const cards: { canvas: HTMLCanvasElement; milestone: TimelineMilestone }[] = []
  for (const milestone of data.milestones) {
    const canvas = await captureCard(milestone, html2canvas, cardW, fontSize)
    cards.push({ canvas, milestone })
  }

  const s = 2
  const cellW = cardW * s
  const rows = Math.ceil(n / cols)

  const rowMaxH: number[] = []
  for (let r = 0; r < rows; r++) {
    let maxH = 0
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c
      if (idx < cards.length) maxH = Math.max(maxH, cards[idx].canvas.height)
    }
    rowMaxH.push(maxH)
  }

  // Extra space at the bottom for the legend
  const legendH = 24 * s
  const gridW = PNG_PAD * s * 2 + cols * cellW + (cols - 1) * PNG_GAP * s
  const gridH = PNG_PAD * s * 2 + rowMaxH.reduce((a, b) => a + b, 0) + (rows - 1) * PNG_GAP * s + legendH

  const grid = document.createElement('canvas')
  grid.width = gridW
  grid.height = gridH
  const ctx = grid.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, gridW, gridH)

  let yOffset = PNG_PAD * s
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c
      if (idx >= cards.length) break
      const { canvas, milestone } = cards[idx]
      const x = PNG_PAD * s + c * (cellW + PNG_GAP * s)
      const isCurrent = milestone.label === 'Current'
      const src = isCurrent ? canvas : blurCanvas(canvas, 6)
      ctx.drawImage(src, x, yOffset)
    }
    yOffset += rowMaxH[r] + PNG_GAP * s
  }

  // Draw legend at the bottom of the grid
  drawCanvasLegend(ctx, PNG_PAD * s, yOffset, s)

  downloadDataUrl(grid.toDataURL('image/png'), 'timeline.png')

  // --- PDF: Current version with real selectable text ---
  const current = data.milestones.find((m) => m.label === 'Current')
  if (current) {
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' })
    renderSpansToPdf(pdf, current.spans, 'Current', current.timestamp, current.event_count)
    pdf.save('timeline-current.pdf')
  }
}

// -- Modal component ----------------------------------------------------------

export default function TimelineModal({ documentId, onClose }: Props) {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<TimelineResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  function loadTimeline() {
    setLoading(true)
    getTimeline(documentId)
      .then(setData)
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'Failed to load timeline.'),
      )
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    loadTimeline()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId])

  async function handleDelete(snapshotId: string) {
    const ok = window.confirm('Delete this snapshot? This cannot be undone.')
    if (!ok) return
    try {
      await deleteSnapshot(snapshotId)
      loadTimeline()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete snapshot.')
    }
  }

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
    <div className="tl-overlay" onClick={onClose}>
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
              No snapshots yet. Click <strong>Suggest</strong> to capture your first timeline snapshot.
            </p>
          )}

          {data && data.milestones.length > 0 && (
            <div className="tl-grid">
              {data.milestones.map((m) => (
                <MilestoneSnapshot key={m.id ?? m.label} milestone={m} onDelete={handleDelete} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
