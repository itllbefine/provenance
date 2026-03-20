import type { Suggestion } from '../api'
import './SidePanel.css'
import './RationalePanel.css'

interface Props {
  suggestion: Suggestion | null
}

export default function RationalePanel({ suggestion }: Props) {
  return (
    <div className="side-panel">
      <div className="panel-header">Rationale</div>
      {suggestion ? (
        <div className="rationale-body">
          <p className="rationale-text">{suggestion.rationale}</p>
        </div>
      ) : (
        <div className="panel-placeholder">
          Click a suggestion to see the reasoning behind it.
        </div>
      )}
    </div>
  )
}
