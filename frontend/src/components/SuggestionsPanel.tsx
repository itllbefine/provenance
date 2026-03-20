import DiffMatchPatch from 'diff-match-patch'
import type { Suggestion } from '../api'
import './SidePanel.css'
import './SuggestionsPanel.css'

interface Props {
  suggestions: Suggestion[]
  focusedIndex: number | null
  isGenerating: boolean
  generateError: string | null
  onGenerate: () => void
  onFocus: (index: number) => void
  onAccept: (index: number) => void
  onDismiss: (index: number) => void
}

const dmp = new DiffMatchPatch()

// Renders a visual diff between `original` and `suggested` as React nodes:
// deletions are <del>, insertions are <ins>, unchanged text is plain.
function DiffView({ original, suggested }: { original: string; suggested: string }) {
  const diffs = dmp.diff_main(original, suggested)
  dmp.diff_cleanupSemantic(diffs)

  return (
    <span className="suggestion-diff">
      {diffs.map(([op, text], i) => {
        if (op === 1) return <ins key={i} className="diff-ins">{text}</ins>
        if (op === -1) return <del key={i} className="diff-del">{text}</del>
        return <span key={i}>{text}</span>
      })}
    </span>
  )
}

const EDIT_TYPE_LABEL: Record<Suggestion['edit_type'], string> = {
  grammar_fix: 'Grammar',
  wording_change: 'Wording',
  organizational_move: 'Structure',
}

export default function SuggestionsPanel({
  suggestions,
  focusedIndex,
  isGenerating,
  generateError,
  onGenerate,
  onFocus,
  onAccept,
  onDismiss,
}: Props) {
  return (
    <div className="side-panel suggestions-panel">
      <div className="panel-header suggestions-header">
        <span>Suggestions</span>
        <button
          className="generate-btn"
          onClick={onGenerate}
          disabled={isGenerating}
          title="Ask Claude for editing suggestions"
        >
          {isGenerating ? 'Thinking…' : 'Suggest'}
        </button>
      </div>

      {generateError && (
        <div className="suggestions-error">{generateError}</div>
      )}

      {!isGenerating && suggestions.length === 0 && !generateError && (
        <div className="panel-placeholder">
          Click <strong>Suggest</strong> to get AI editing suggestions for this document.
        </div>
      )}

      <div className="suggestions-list">
        {suggestions.map((s, i) => (
          <div
            key={s.id}
            className={`suggestion-card${focusedIndex === i ? ' suggestion-card--focused' : ''}`}
            onClick={() => onFocus(i)}
          >
            <div className="suggestion-card__meta">
              <span className={`suggestion-badge suggestion-badge--${s.edit_type}`}>
                {EDIT_TYPE_LABEL[s.edit_type]}
              </span>
            </div>
            <div className="suggestion-card__diff">
              <DiffView original={s.original_text} suggested={s.suggested_text} />
            </div>
            <div className="suggestion-card__actions">
              <button
                className="suggestion-action suggestion-action--accept"
                onClick={(e) => { e.stopPropagation(); onAccept(i) }}
                title="Accept this suggestion"
              >
                Accept
              </button>
              <button
                className="suggestion-action suggestion-action--dismiss"
                onClick={(e) => { e.stopPropagation(); onDismiss(i) }}
                title="Dismiss this suggestion"
              >
                Dismiss
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
