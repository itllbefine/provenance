import { useEffect, useRef, useState } from 'react'
import {
  deleteStyleSample,
  getYounessScore,
  listStyleSamples,
  uploadStyleSample,
} from '../api'
import type { StyleSample, YounessScore } from '../api'
import './YounessModal.css'

interface Props {
  documentId: string
  onClose: () => void
}

export default function YounessModal({ documentId, onClose }: Props) {
  const [samples, setSamples] = useState<StyleSample[]>([])
  const [score, setScore] = useState<YounessScore | null>(null)
  const [loadingSamples, setLoadingSamples] = useState(true)
  const [scoring, setScoring] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Hidden file input — triggered programmatically by the Upload button
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetchSamples()
  }, [])

  async function fetchSamples() {
    setLoadingSamples(true)
    try {
      setSamples(await listStyleSamples())
    } catch {
      setError('Failed to load samples.')
    } finally {
      setLoadingSamples(false)
    }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setError(null)
    try {
      await uploadStyleSample(file)
      await fetchSamples()
      setScore(null) // existing score is stale after adding a sample
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.')
    } finally {
      setUploading(false)
      // Reset the input so the same file can be re-uploaded if needed
      e.target.value = ''
    }
  }

  async function handleDelete(id: string) {
    setError(null)
    try {
      await deleteStyleSample(id)
      await fetchSamples()
      setScore(null) // existing score is stale after removing a sample
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed.')
    }
  }

  async function handleScore() {
    setScoring(true)
    setError(null)
    try {
      setScore(await getYounessScore(documentId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scoring failed.')
    } finally {
      setScoring(false)
    }
  }

  return (
    // Clicking the overlay (outside the modal card) closes the modal
    <div className="youness-overlay" onClick={onClose}>
      {/* stopPropagation prevents clicks inside the card from bubbling to the overlay */}
      <div className="youness-modal" onClick={(e) => e.stopPropagation()}>
        <div className="youness-header">
          <h2 className="youness-title">You-ness Score</h2>
          <button className="youness-close" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        <div className="youness-body">
          {/* ── Baseline samples section ── */}
          <section className="youness-section">
            <div className="youness-section-header">
              <h3>Baseline Samples</h3>
              <button
                className="youness-upload-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? 'Uploading…' : '+ Upload sample'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,text/plain"
                style={{ display: 'none' }}
                onChange={handleUpload}
              />
            </div>

            {loadingSamples ? (
              <p className="youness-hint">Loading…</p>
            ) : samples.length === 0 ? (
              <p className="youness-hint">
                No samples yet. Upload plain-text examples of your own writing
                so the scorer can learn your style.
              </p>
            ) : (
              <ul className="youness-sample-list">
                {samples.map((s) => (
                  <li key={s.id} className="youness-sample-item">
                    <span className="youness-sample-name">{s.filename}</span>
                    <span className="youness-sample-meta">
                      {(s.char_count / 1000).toFixed(1)}k chars
                    </span>
                    <button
                      className="youness-delete-btn"
                      onClick={() => handleDelete(s.id)}
                      title="Remove sample"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ── Score section ── */}
          <section className="youness-section">
            <div className="youness-section-header">
              <h3>Score</h3>
              <button
                className="youness-score-btn"
                onClick={handleScore}
                disabled={scoring || samples.length === 0}
                title={samples.length === 0 ? 'Upload baseline samples first' : undefined}
              >
                {scoring ? 'Scoring…' : 'Compute score'}
              </button>
            </div>

            {error && <p className="youness-error">{error}</p>}

            {score ? (
              <div className="youness-score-display">
                <div className="youness-score-circle">
                  <span className="youness-score-number">{score.score}</span>
                  <span className="youness-score-label">/ 100</span>
                </div>

                <p className="youness-explanation">{score.explanation}</p>

                <div className="youness-breakdown">
                  <div className="youness-breakdown-labels">
                    <span>Human {score.human_pct}%</span>
                    <span>AI {score.ai_pct}%</span>
                  </div>
                  <div className="youness-bar">
                    <div
                      className="youness-bar-human"
                      style={{ width: `${score.human_pct}%` }}
                    />
                    <div
                      className="youness-bar-ai"
                      style={{ width: `${score.ai_pct}%` }}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <p className="youness-hint">
                {samples.length === 0
                  ? 'Upload baseline samples first.'
                  : 'Click "Compute score" to analyse this document.'}
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
