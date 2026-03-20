import DiffMatchPatch from 'diff-match-patch'
import { useEffect, useRef, useState } from 'react'
import type { ChatMessage, SuggestedEdit, Suggestion } from '../api'
import { chatWithContext } from '../api'
import './SidePanel.css'
import './RationalePanel.css'

interface LocalMessage {
  role: 'user' | 'assistant'
  content: string
  suggestedEdit?: SuggestedEdit
}

interface Props {
  suggestion: Suggestion | null
  documentId: string
  suggestionModel: 'claude-sonnet-4-6' | 'claude-opus-4-6'
  /** Text the user has selected in the editor — persists after focus leaves. */
  activeSelection: string | null
  /** Call to dismiss the stored selection (e.g. user clicks the ✕ on the preview). */
  onClearSelection: () => void
  onAcceptChatEdit: (original: string, suggested: string, editType: string) => void
}

const dmp = new DiffMatchPatch()

function DiffView({ original, suggested }: { original: string; suggested: string }) {
  const diffs = dmp.diff_main(original, suggested)
  dmp.diff_cleanupSemantic(diffs)
  return (
    <span className="chat-diff">
      {diffs.map(([op, text], i) => {
        if (op === 1) return <ins key={i} className="diff-ins">{text}</ins>
        if (op === -1) return <del key={i} className="diff-del">{text}</del>
        return <span key={i}>{text}</span>
      })}
    </span>
  )
}

export default function RationalePanel({
  suggestion,
  documentId,
  suggestionModel,
  activeSelection,
  onClearSelection,
  onAcceptChatEdit,
}: Props) {
  const [messages, setMessages] = useState<LocalMessage[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const threadRef = useRef<HTMLDivElement>(null)

  // Reset conversation when the focused suggestion changes
  const suggestionId = suggestion?.id ?? null
  useEffect(() => {
    setMessages([])
    setInput('')
    setError(null)
  }, [suggestionId])

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight
    }
  }, [messages])

  async function handleSend() {
    const text = input.trim()
    if (!text || isLoading) return

    // Context priority: focused suggestion > persisted editor selection
    const contextText = suggestion?.original_text ?? activeSelection ?? ''

    const userMessage: LocalMessage = { role: 'user', content: text }
    const nextMessages = [...messages, userMessage]
    setMessages(nextMessages)
    setInput('')
    // Clear the selection preview once the user has sent — it has been consumed
    // as context and a new selection will be needed for the next question.
    onClearSelection()
    setIsLoading(true)
    setError(null)

    try {
      // Only send role+content to the API
      const apiMessages: ChatMessage[] = nextMessages.map(({ role, content }) => ({ role, content }))
      const res = await chatWithContext(documentId, contextText, apiMessages, suggestionModel)

      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: res.message,
          suggestedEdit: res.suggested_edit ?? undefined,
        },
      ])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get response')
    } finally {
      setIsLoading(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  return (
    <div className="side-panel rationale-panel">
      <div className="panel-header">Rationale</div>

      <div className="rationale-scroll" ref={threadRef}>
        {suggestion && (
          <div className="rationale-body">
            <p className="rationale-text">{suggestion.rationale}</p>
          </div>
        )}

        {messages.length === 0 && !suggestion && (
          <div className="panel-placeholder">
            Select text or click a suggestion, then ask a question below.
          </div>
        )}

        {messages.length > 0 && (
          <div className="chat-thread">
            {messages.map((msg, i) => (
              <div key={i} className={`chat-message chat-message--${msg.role}`}>
                <div className="chat-bubble">
                  <p className="chat-text">{msg.content}</p>
                  {msg.suggestedEdit && (
                    <div className="chat-edit-proposal">
                      <DiffView
                        original={msg.suggestedEdit.original_text}
                        suggested={msg.suggestedEdit.suggested_text}
                      />
                      <button
                        className="chat-accept-btn"
                        onClick={() =>
                          onAcceptChatEdit(
                            msg.suggestedEdit!.original_text,
                            msg.suggestedEdit!.suggested_text,
                            msg.suggestedEdit!.edit_type,
                          )
                        }
                      >
                        Accept
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="chat-message chat-message--assistant">
                <div className="chat-bubble chat-bubble--loading">Thinking…</div>
              </div>
            )}
          </div>
        )}

        {error && <div className="chat-error">{error}</div>}
      </div>

      {activeSelection && !suggestion && (
        <div className="chat-selection-preview">
          <span className="chat-selection-quote">
            {activeSelection.length > 120
              ? activeSelection.slice(0, 120).trimEnd() + '…'
              : activeSelection}
          </span>
          <button
            className="chat-selection-clear"
            onClick={onClearSelection}
            title="Clear selection"
            aria-label="Clear selection"
          >
            ✕
          </button>
        </div>
      )}

      <div className="chat-input-area">
        <textarea
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            suggestion
              ? 'Ask about this suggestion…'
              : 'Ask about selected text…'
          }
          rows={2}
          disabled={isLoading}
        />
        <button
          className="chat-send-btn"
          onClick={() => void handleSend()}
          disabled={!input.trim() || isLoading}
        >
          Send
        </button>
      </div>
    </div>
  )
}
