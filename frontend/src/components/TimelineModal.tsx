import { useEffect, useState } from 'react'
import type { TimelineMilestone, TimelineResponse, TimelineSpan } from '../api'
import { getTimeline, deleteSnapshot } from '../api'
import './TimelineModal.css'

interface Props {
  documentId: string
  onClose: () => void
}

// -- Shared color definitions -------------------------------------------------

// Legend items keyed by origin. Order: Human (transparent), AI Influenced, AI Assisted, AI Generated.
// "AI Assisted" covers both ai_modified (panel accept) and ai_collaborative (chat accept).
const LEGEND_ITEMS: { label: string; origins: string[]; cssColor: string; rgb: [number, number, number] }[] = [
  { label: 'Human',          origins: ['human', 'human_edit'], cssColor: 'transparent',              rgb: [255, 255, 255] },
  { label: 'AI Influenced',  origins: ['ai_influenced'],       cssColor: 'rgba(34, 211, 238, 0.55)', rgb: [34, 211, 238] },
  { label: 'AI Assisted',    origins: ['ai_modified', 'ai_collaborative'], cssColor: 'rgba(74, 222, 128, 0.55)', rgb: [74, 222, 128] },
  { label: 'AI Generated',   origins: ['ai_generated'],        cssColor: 'rgba(251, 191, 36, 0.50)', rgb: [251, 191, 36] },
]

// Map origin to legend index
const ORIGIN_INDEX: Record<string, number> = {}
LEGEND_ITEMS.forEach((item, i) => {
  for (const o of item.origins) ORIGIN_INDEX[o] = i
})

/**
 * Count non-space, non-newline body characters per legend category and return
 * rounded percentages that always sum to exactly 100. The largest category
 * absorbs any rounding remainder.
 */
function computeAttribPcts(spans: TimelineSpan[]): number[] {
  const counts: number[] = Array.from({ length: LEGEND_ITEMS.length }, () => 0)
  for (const span of spans) {
    if (span.origin === 'boundary') continue
    const idx = ORIGIN_INDEX[span.origin] ?? 0
    for (const ch of span.text) {
      if (ch !== ' ' && ch !== '\n' && ch !== '\t') counts[idx]++
    }
  }
  const total = counts.reduce((a, b) => a + b, 0)
  if (total === 0) return Array.from({ length: LEGEND_ITEMS.length }, () => 0)

  const floored: number[] = counts.map((c) => Math.floor((c / total) * 100))
  const remainder = 100 - floored.reduce((a, b) => a + b, 0)
  if (remainder > 0) {
    let maxIdx = 0
    for (let i = 1; i < counts.length; i++) {
      if (counts[i] > counts[maxIdx]) maxIdx = i
    }
    floored[maxIdx] += remainder
  }
  return floored
}

/**
 * Map a provenance origin to a CSS background-color string.
 */
function spanBg(origin: string, _editType: string | null): string {
  if (origin === 'boundary') return 'transparent'
  if (origin === 'human' || origin === 'human_edit') return 'transparent'

  const idx = ORIGIN_INDEX[origin]
  if (idx !== undefined) return LEGEND_ITEMS[idx].cssColor
  // Fallback for unknown AI origins
  return LEGEND_ITEMS[0].cssColor
}

/**
 * Return an RGB triple blended against white at the given alpha,
 * or null if the span should have no background.
 */
function spanPdfBg(origin: string, _editType: string | null): [number, number, number] | null {
  if (origin === 'boundary' || origin === 'human' || origin === 'human_edit') return null

  const idx = ORIGIN_INDEX[origin]
  const [r, g, b] = idx !== undefined ? LEGEND_ITEMS[idx].rgb : LEGEND_ITEMS[0].rgb

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

function ColorKey({ pcts }: { pcts?: number[] }) {
  return (
    <div className="tl-legend">
      <div className="tl-legend-group">
        {LEGEND_ITEMS.map((item, i) => (
          <span key={item.label} className="tl-legend-item">
            <span className="tl-legend-swatch" style={{ background: item.cssColor === 'transparent' ? '#fff' : item.cssColor, border: item.cssColor === 'transparent' ? '1px solid #ddd' : 'none' }} />
            {item.label}{pcts ? ` — ${pcts[i]}%` : ''}
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
  const swatchW = 14 * s
  const swatchH = 14 * s
  const itemGap = 16 * s
  const textOffset = swatchW + 5 * s

  ctx.font = `bold ${12 * s}px sans-serif`
  let cx = x
  for (const item of LEGEND_ITEMS) {
    const [r, g, b] = item.rgb
    if (item.cssColor === 'transparent') {
      // Human swatch: light fill with border
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(cx, y, swatchW, swatchH)
      ctx.strokeStyle = '#ddd'
      ctx.lineWidth = 1 * s
      ctx.strokeRect(cx, y, swatchW, swatchH)
    } else {
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.55)`
      ctx.fillRect(cx, y, swatchW, swatchH)
    }
    ctx.fillStyle = '#666'
    ctx.fillText(item.label, cx + textOffset, y + swatchH - 1 * s)
    cx += textOffset + ctx.measureText(item.label).width + itemGap
  }

  return swatchH + 6 * s
}

// -- PDF export: real selectable text with jsPDF ------------------------------

type JsPDF = InstanceType<typeof import('jspdf').jsPDF>

/** Draw the color key legend onto a PDF page. Returns the y position after the legend. */
function drawPdfLegend(pdf: JsPDF, margin: number, y: number, s = 1): number {
  const swatchW = 10 * s
  const swatchH = 10 * s
  const itemGap = 12 * s
  const textOff = swatchW + 4 * s

  pdf.setFont('helvetica', 'bold')
  pdf.setFontSize(11 * s)
  let cx = margin
  for (const item of LEGEND_ITEMS) {
    if (item.cssColor === 'transparent') {
      pdf.setFillColor(255, 255, 255)
      pdf.rect(cx, y, swatchW, swatchH, 'F')
      pdf.setDrawColor(221, 221, 221)
      pdf.rect(cx, y, swatchW, swatchH, 'S')
    } else {
      const a = 0.30
      const r = Math.round(255 * (1 - a) + item.rgb[0] * a)
      const g = Math.round(255 * (1 - a) + item.rgb[1] * a)
      const b = Math.round(255 * (1 - a) + item.rgb[2] * a)
      pdf.setFillColor(r, g, b)
      pdf.rect(cx, y, swatchW, swatchH, 'F')
    }
    pdf.setTextColor(102, 102, 102)
    pdf.text(item.label, cx + textOff, y + swatchH - 1 * s)
    cx += textOff + pdf.getTextWidth(item.label) + itemGap
  }

  return y + swatchH + 8 * s
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
  // Scale all sizes proportionally to page width (letter = 612pt baseline)
  const scale = pageW / 612
  const margin = Math.round(40 * scale)
  const maxX = pageW - margin
  const bodyFontSize = Math.round(11 * scale)
  const lineH = bodyFontSize * 1.5
  const ascent = bodyFontSize * 0.8

  // --- Header (page 1) ---
  pdf.setFont('times', 'bold')
  pdf.setFontSize(Math.round(16 * scale))
  pdf.setTextColor(26, 26, 24)
  pdf.text(label, margin, margin + Math.round(16 * scale))

  pdf.setFont('times', 'normal')
  pdf.setFontSize(Math.round(9 * scale))
  pdf.setTextColor(160, 160, 160)
  pdf.text(
    `${eventCount} edit${eventCount !== 1 ? 's' : ''} · ${fmtTimestamp(timestamp)}`,
    margin,
    margin + Math.round(28 * scale),
  )

  let startY = drawPdfLegend(pdf, margin, margin + Math.round(38 * scale), scale)
  pdf.setDrawColor(220, 220, 220)
  pdf.line(margin, startY, pageW - margin, startY)
  startY += Math.round(12 * scale)

  // --- Build a flat character buffer with per-char colors ---
  // Each char gets the background color from its provenance span.
  type CharEntry = { ch: string; bg: [number, number, number] | null }
  const charBuf: (CharEntry | 'para')[] = []

  for (const span of spans) {
    if (span.origin === 'boundary') continue
    const bg = spanPdfBg(span.origin, span.edit_type)
    for (const ch of span.text) {
      if (ch === '\n') {
        charBuf.push('para')
      } else {
        charBuf.push({ ch, bg })
      }
    }
  }

  // --- Tokenize into words and whitespace, preserving per-char colors ---
  // A "word token" is a contiguous run of non-space chars; wrapping only
  // breaks between tokens, never inside a word.
  type ColorRun = { text: string; bg: [number, number, number] | null }
  type WordToken = { runs: ColorRun[]; fullText: string; paraBreak?: boolean }
  const tokens: WordToken[] = []
  let currentRuns: ColorRun[] = []
  let currentText = ''

  function flushWord() {
    if (currentText) {
      tokens.push({ runs: currentRuns, fullText: currentText })
      currentRuns = []
      currentText = ''
    }
  }

  function appendChar(ch: string, bg: [number, number, number] | null) {
    const lastRun = currentRuns[currentRuns.length - 1]
    const sameColor = lastRun && (
      (lastRun.bg === null && bg === null) ||
      (lastRun.bg !== null && bg !== null &&
        lastRun.bg[0] === bg[0] && lastRun.bg[1] === bg[1] && lastRun.bg[2] === bg[2])
    )
    if (sameColor) {
      lastRun.text += ch
    } else {
      currentRuns.push({ text: ch, bg })
    }
    currentText += ch
  }

  for (const entry of charBuf) {
    if (entry === 'para') {
      flushWord()
      tokens.push({ runs: [], fullText: '', paraBreak: true })
    } else if (entry.ch === ' ' || entry.ch === '\t') {
      // Whitespace is its own token (can be dropped at line breaks)
      flushWord()
      appendChar(entry.ch, entry.bg)
      flushWord()
    } else {
      appendChar(entry.ch, entry.bg)
    }
  }
  flushWord()

  // --- Pass 1: compute layout positions ---
  // Each placed item is one color-run within a word, positioned on the page.
  type Placed = { page: number; x: number; y: number; w: number; text: string; bg: [number, number, number] | null }
  const placed: Placed[] = []
  let page = 1
  let x = margin
  let y = startY
  const pageHeaderY: Map<number, number> = new Map()
  pageHeaderY.set(1, startY)

  pdf.setFont('times', 'normal')
  pdf.setFontSize(bodyFontSize)

  function advancePage() {
    page++
    pdf.addPage()
    y = margin
    y = drawPdfLegend(pdf, margin, y, scale)
    pdf.setDrawColor(220, 220, 220)
    pdf.line(margin, y, pageW - margin, y)
    y += Math.round(12 * scale)
    pageHeaderY.set(page, y)
    pdf.setFont('times', 'normal')
    pdf.setFontSize(bodyFontSize)
  }

  for (const token of tokens) {
    if (token.paraBreak) {
      x = margin
      y += lineH * 1.2
      if (y > pageH - margin) advancePage()
      x = margin
      continue
    }

    pdf.setFont('times', 'normal')
    pdf.setFontSize(bodyFontSize)
    const fullW = pdf.getTextWidth(token.fullText)

    // Line wrap: break before the whole word if it doesn't fit
    if (x + fullW > maxX && x > margin) {
      if (token.fullText.trim() === '') continue // drop whitespace at line break
      x = margin
      y += lineH
      if (y > pageH - margin) advancePage()
    }

    // Place each color run within this word
    for (const run of token.runs) {
      const w = pdf.getTextWidth(run.text)
      placed.push({ page, x, y, w, text: run.text, bg: run.bg })
      x += w
    }
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

  // --- Attribution footer (italic, after body text) ---
  const pcts = computeAttribPcts(spans)
  const footerLines = [
    'Made with Provenance',
    `Human — ${pcts[0]}%`,
    `AI-Influenced — ${pcts[1]}%`,
    `AI-Assisted — ${pcts[2]}%`,
    `AI-Generated — ${pcts[3]}%`,
  ]
  const footerFontSize = Math.round(9 * scale)
  const footerLineH = footerFontSize * 1.6

  pdf.setPage(totalPages)
  let fy = y + lineH * 2
  if (fy + footerLines.length * footerLineH > pageH - margin) {
    pdf.addPage()
    fy = margin + Math.round(20 * scale)
  }
  pdf.setFont('times', 'italic')
  pdf.setFontSize(footerFontSize)
  pdf.setTextColor(140, 140, 140)
  for (const line of footerLines) {
    pdf.text(line, margin, fy)
    fy += footerLineH
  }
}

// -- Main export function -----------------------------------------------------

const PNG_SIZE = 1080
const PNG_GAP = 10
const PNG_PAD = 16
const MIN_CARD_W = 80

async function exportTimeline(data: TimelineResponse): Promise<void> {
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
    import('html2canvas'),
    import('jspdf'),
  ])

  const n = data.milestones.length
  if (n === 0) return

  // --- PNG: 1080×1080 thumbnail grid ---
  // Work in CSS pixels at half the target (scale=2 in html2canvas doubles it).
  const halfSize = PNG_SIZE / 2
  const maxColsForWidth = Math.floor((halfSize + PNG_GAP) / (MIN_CARD_W + PNG_GAP))
  const cols = Math.min(n, maxColsForWidth)
  const cardW = Math.floor((halfSize - PNG_PAD * 2 - (cols - 1) * PNG_GAP) / cols)
  const fontSize = Math.max(4, Math.min(9, cardW / 30))

  const cards: { canvas: HTMLCanvasElement; milestone: TimelineMilestone }[] = []
  for (const milestone of data.milestones) {
    const canvas = await captureCard(milestone, html2canvas, cardW, fontSize)
    cards.push({ canvas, milestone })
  }

  const s = 2 // html2canvas scale factor
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

  const legendH = 32 * s
  const contentH = PNG_PAD * s * 2 + rowMaxH.reduce((a, b) => a + b, 0) + (rows - 1) * PNG_GAP * s + legendH

  const grid = document.createElement('canvas')
  grid.width = PNG_SIZE
  grid.height = PNG_SIZE
  const ctx = grid.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, PNG_SIZE, PNG_SIZE)

  // Center content vertically in the 1080×1080 square
  const topOffset = Math.max(PNG_PAD * s, Math.floor((PNG_SIZE - contentH) / 2))
  // Center content horizontally
  const gridContentW = cols * cellW + (cols - 1) * PNG_GAP * s
  const leftOffset = Math.floor((PNG_SIZE - gridContentW) / 2)

  let yOffset = topOffset
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c
      if (idx >= cards.length) break
      const { canvas, milestone } = cards[idx]
      const x = leftOffset + c * (cellW + PNG_GAP * s)
      const isCurrent = milestone.label === 'Current'
      const src = isCurrent ? canvas : blurCanvas(canvas, 3)
      ctx.drawImage(src, x, yOffset)
    }
    yOffset += rowMaxH[r] + PNG_GAP * s
  }

  // Draw legend centered at the bottom of the content
  const legendScale = s
  // Measure legend width to center it
  ctx.font = `bold ${12 * legendScale}px sans-serif`
  const swatchW = 14 * legendScale
  const textOff = swatchW + 5 * legendScale
  const itemGap = 16 * legendScale
  let legendW = 0
  for (const item of LEGEND_ITEMS) {
    legendW += textOff + ctx.measureText(item.label).width + itemGap
  }
  legendW -= itemGap // no trailing gap
  const legendX = Math.floor((PNG_SIZE - legendW) / 2)
  drawCanvasLegend(ctx, legendX, yOffset, legendScale)

  downloadDataUrl(grid.toDataURL('image/png'), 'timeline.png')

  const current = data.milestones.find((m) => m.label === 'Current')
  if (current) {
    // --- PDF letter: 8.5"×11" with real selectable text ---
    const pdfLetter = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' })
    renderSpansToPdf(pdfLetter, current.spans, 'Current', current.timestamp, current.event_count)
    pdfLetter.save('timeline-current.pdf')

    // --- PDF square: 1080×1080px (converted to pt: 1080 * 72/96 = 810pt) ---
    const squarePt = 1080 * 72 / 96
    const pdfSquare = new jsPDF({ orientation: 'portrait', unit: 'pt', format: [squarePt, squarePt] })
    renderSpansToPdf(pdfSquare, current.spans, 'Current', current.timestamp, current.event_count)
    pdfSquare.save('timeline-current-square.pdf')
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
  const currentSpans = data?.milestones.find((m) => m.label === 'Current')?.spans
  const attribPcts = currentSpans ? computeAttribPcts(currentSpans) : undefined

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
                : 'Export snapshots (PNG + letter PDF + square PDF)'
            }
          >
            {exporting ? 'Exporting…' : 'Export'}
          </button>

          <button className="tl-close" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        {exportError && <p className="tl-export-error">{exportError}</p>}

        <ColorKey pcts={attribPcts} />

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
