import json
import os

import aiosqlite
import anthropic
from fastapi import APIRouter, Depends, HTTPException

from database import get_db
from models import ALLOWED_SUGGESTION_MODELS, SuggestionRequest, SuggestionResponse

router = APIRouter(prefix="/suggestions", tags=["suggestions"])

# Lazily initialized so missing API key only raises at call time, not at startup.
_client: anthropic.AsyncAnthropic | None = None


def get_client() -> anthropic.AsyncAnthropic:
    global _client
    if _client is None:
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise HTTPException(
                status_code=503,
                detail="ANTHROPIC_API_KEY is not configured. Add it to backend/.env.",
            )
        _client = anthropic.AsyncAnthropic(api_key=api_key)
    return _client


def extract_text(node: dict) -> str:
    """
    Recursively extract plain text from a ProseMirror JSON node.

    ProseMirror documents are trees. Leaf 'text' nodes carry the actual
    characters. Block nodes (paragraph, heading, …) wrap text nodes and
    should be separated by newlines so Claude sees the document structure.
    """
    if node.get("type") == "text":
        return node.get("text", "")

    children = node.get("content", [])
    parts = [extract_text(child) for child in children]
    text = "".join(parts)

    block_types = {"paragraph", "heading", "blockquote", "listItem", "codeBlock"}
    if node.get("type") in block_types:
        # Separate block-level elements with a blank line
        return text + "\n\n" if text.strip() else ""

    return text


# Tool definition that forces Claude to return structured JSON.
# Using tool_use (rather than asking for JSON in the prompt) is more reliable
# because the model is trained to fill tool inputs faithfully.
SUGGESTION_TOOL: dict = {
    "name": "record_suggestions",
    "description": "Record a list of editing suggestions for the document.",
    "input_schema": {
        "type": "object",
        "properties": {
            "suggestions": {
                "type": "array",
                "description": "The editing suggestions, ordered by importance.",
                "items": {
                    "type": "object",
                    "properties": {
                        "original_text": {
                            "type": "string",
                            "description": (
                                "The EXACT verbatim text from the document that should "
                                "be changed — copy it character-for-character."
                            ),
                        },
                        "suggested_text": {
                            "type": "string",
                            "description": "The replacement text.",
                        },
                        "rationale": {
                            "type": "string",
                            "description": (
                                "A brief, specific explanation of why this change "
                                "improves the writing — not just what it does."
                            ),
                        },
                        "edit_type": {
                            "type": "string",
                            "enum": [
                                "grammar_fix",
                                "wording_change",
                                "organizational_move",
                            ],
                            "description": (
                                "grammar_fix: spelling/punctuation/grammar correction. "
                                "wording_change: clarity, tone, or flow improvement. "
                                "organizational_move: restructuring or reordering text."
                            ),
                        },
                    },
                    "required": [
                        "original_text",
                        "suggested_text",
                        "rationale",
                        "edit_type",
                    ],
                },
            }
        },
        "required": ["suggestions"],
    },
}

SYSTEM_PROMPT = """You are a thoughtful writing editor. Your job is to suggest specific, targeted improvements to the document the user provides.

Guidelines:
- Suggest 3–5 improvements, prioritizing the most impactful changes.
- Each suggestion must cite an EXACT verbatim excerpt from the document as `original_text` — copy it character-for-character, including punctuation. Do not paraphrase or shorten it.
- Keep suggestions focused: change only what needs changing, not whole paragraphs.
- Be specific in your rationale: explain *why* this change improves the writing.
- Prefer targeted word or phrase changes over wholesale rewrites."""


@router.post("/generate", response_model=list[SuggestionResponse])
async def generate_suggestions(
    body: SuggestionRequest,
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Fetch the document, extract plain text, call Claude to get editing
    suggestions, and return them as structured data.
    """
    async with db.execute(
        "SELECT content, title, context FROM documents WHERE id = ?", (body.document_id,)
    ) as cursor:
        row = await cursor.fetchone()

    if row is None:
        raise HTTPException(status_code=404, detail="Document not found")

    try:
        content_doc = json.loads(row["content"])
        document_text = extract_text(content_doc).strip()
    except (json.JSONDecodeError, AttributeError):
        document_text = ""

    # Require a minimum amount of text so Claude has something to work with.
    if len(document_text) < 50:
        raise HTTPException(
            status_code=422,
            detail="Document is too short to suggest edits. Write at least a few sentences first.",
        )

    title = row["title"]
    doc_context = (row["context"] or "").strip()

    # Build an effective system prompt: start with the base instructions, then
    # append the user-supplied document context if one was provided.
    effective_system = SYSTEM_PROMPT
    if doc_context:
        effective_system += (
            f"\n\nDocument context (provided by the author — let this guide your "
            f"suggestions about tone, purpose, and audience):\n{doc_context}"
        )

    user_message = (
        f"Title: {title}\n\n{document_text}"
        if title and title != "Untitled"
        else document_text
    )

    # Keep only dismissed originals that still appear verbatim in the document.
    # If the text was changed, it won't match and is silently dropped — this
    # implements the "unless I make a change to it" behaviour.
    active_dismissed = [t for t in body.dismissed if t in document_text]

    if active_dismissed:
        dismissed_block = "\n".join(f'- "{t}"' for t in active_dismissed)
        user_message += (
            f"\n\nThe user has already dismissed the following suggestions and does NOT "
            f"want them suggested again. Do not include any suggestion whose "
            f"`original_text` matches one of these:\n{dismissed_block}"
        )

    if body.model not in ALLOWED_SUGGESTION_MODELS:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid model. Allowed values: {', '.join(sorted(ALLOWED_SUGGESTION_MODELS))}",
        )

    client = get_client()

    # tool_choice="any" forces Claude to call one of the provided tools.
    # This guarantees a structured response rather than a plain-text reply.
    response = await client.messages.create(
        model=body.model,
        max_tokens=4096,
        system=effective_system,
        tools=[SUGGESTION_TOOL],
        tool_choice={"type": "any"},
        messages=[{"role": "user", "content": user_message}],
    )

    # The response content is a list of blocks. Find the tool_use block.
    suggestions_raw: list[dict] = []
    for block in response.content:
        if block.type == "tool_use" and block.name == "record_suggestions":
            suggestions_raw = block.input.get("suggestions", [])
            break

    # Safety net: drop any suggestion whose original_text is still dismissed,
    # in case Claude ignored the instruction.
    dismissed_set = set(active_dismissed)
    suggestions_raw = [s for s in suggestions_raw if s["original_text"] not in dismissed_set]

    return [
        SuggestionResponse(
            id=str(i),
            original_text=s["original_text"],
            suggested_text=s["suggested_text"],
            rationale=s["rationale"],
            edit_type=s["edit_type"],
        )
        for i, s in enumerate(suggestions_raw)
    ]
