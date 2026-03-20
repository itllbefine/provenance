"""
You-ness scoring — Phase 6.

Endpoints:
  POST   /youness/samples          — upload a plain-text baseline writing sample
  GET    /youness/samples          — list uploaded samples
  DELETE /youness/samples/{id}     — remove a sample
  GET    /youness/score/{doc_id}   — compute the you-ness score for a document

The score is computed by Claude Haiku, which compares the document text
against the uploaded baseline samples and returns a 0–100 stylometric
similarity score with a plain-English explanation.

The human/AI authorship breakdown is computed independently from the stored
provenance events (sum of inserted-text length by origin), so it's available
even when no baseline samples have been uploaded.
"""

import json
import os
import uuid
from datetime import datetime, timezone

import aiosqlite
import anthropic
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from database import get_db
from models import StyleSampleResponse, YounessScoreResponse

# Import the plain-text extractor that already exists in suggestions.py.
# This avoids duplicating the recursive ProseMirror-JSON-to-text logic.
from routers.suggestions import extract_text

router = APIRouter(prefix="/youness", tags=["youness"])

# ── Constants ─────────────────────────────────────────────────────────────────

# Maximum characters we store per uploaded sample (prevents huge DB rows).
MAX_SAMPLE_CHARS = 50_000

# When building the Claude prompt, use at most 3 samples, each capped at
# 2 000 chars. Enough stylistic signal without ballooning the prompt.
MAX_SAMPLES_IN_PROMPT = 3
MAX_CHARS_PER_SAMPLE = 2_000

# ── Lazy Anthropic client ─────────────────────────────────────────────────────

# Same lazy-init pattern used in suggestions.py and classify.py: the client is
# created once on first use, so a missing API key only errors at call time.
_client: anthropic.AsyncAnthropic | None = None


def _get_client() -> anthropic.AsyncAnthropic | None:
    """Return a lazily-initialised Anthropic client, or None if the key is absent."""
    global _client
    if _client is None:
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            return None
        _client = anthropic.AsyncAnthropic(api_key=api_key)
    return _client


# ── Claude tool + prompt ──────────────────────────────────────────────────────

# We use tool_use (same technique as suggestions.py) to get structured JSON back
# from Claude instead of hoping it formats a free-text response correctly.
SCORE_TOOL: dict = {
    "name": "record_youness_score",
    "description": "Record the you-ness score and plain-English explanation for the document.",
    "input_schema": {
        "type": "object",
        "properties": {
            "score": {
                "type": "integer",
                "description": (
                    "How much the document sounds like the author, 0–100. "
                    "0 = sounds nothing like the baseline samples. "
                    "100 = virtually indistinguishable from the baseline."
                ),
            },
            "explanation": {
                "type": "string",
                "description": (
                    "2–3 sentences in plain English explaining what specific "
                    "stylistic features raised or lowered the score. "
                    "Name concrete features: sentence length, vocabulary, "
                    "punctuation habits, paragraph rhythm, etc."
                ),
            },
        },
        "required": ["score", "explanation"],
    },
}

SCORE_SYSTEM_PROMPT = """\
You are a stylometric analyst. Given baseline writing samples from an author \
and a document to score, estimate how much the document sounds like the author.

Analyze these stylistic features:
- Sentence length and rhythm (short/punchy vs. long/flowing)
- Vocabulary level and word choice (formal/informal, technical/plain)
- Punctuation habits (em-dashes, semicolons, parenthetical asides, ellipses)
- Paragraph length and structure
- Characteristic phrases or constructions

Score the document 0–100 (0 = sounds nothing like the author, 100 = indistinguishable). \
Use the full range: no resemblance → near 0, close match on all features → near 100.

Keep your explanation to 2–3 sentences and name specific features, not vague generalities.\
"""


# ── Endpoints ─────────────────────────────────────────────────────────────────


@router.post("/samples", response_model=StyleSampleResponse, status_code=201)
async def upload_sample(
    file: UploadFile = File(...),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Upload a plain-text baseline writing sample.

    The file is read as bytes and decoded as UTF-8. The `errors='replace'`
    argument swaps any undecodable bytes with the replacement character (?)
    instead of raising an exception, so binary files don't cause a 500 error.
    """
    raw = await file.read()
    text = raw.decode("utf-8", errors="replace")[:MAX_SAMPLE_CHARS]

    if not text.strip():
        raise HTTPException(status_code=422, detail="File is empty.")

    sample_id = str(uuid.uuid4())
    uploaded_at = datetime.now(timezone.utc).isoformat()
    filename = file.filename or "sample.txt"

    await db.execute(
        "INSERT INTO style_samples (id, text, filename, uploaded_at) VALUES (?, ?, ?, ?)",
        (sample_id, text, filename, uploaded_at),
    )
    await db.commit()

    return StyleSampleResponse(
        id=sample_id,
        filename=filename,
        uploaded_at=uploaded_at,
        char_count=len(text),
    )


@router.get("/samples", response_model=list[StyleSampleResponse])
async def list_samples(db: aiosqlite.Connection = Depends(get_db)):
    """List all uploaded baseline writing samples, newest first."""
    async with db.execute(
        # length(text) is an SQLite function that returns the number of
        # characters in the text column — equivalent to len() in Python.
        "SELECT id, filename, uploaded_at, length(text) AS char_count "
        "FROM style_samples ORDER BY uploaded_at DESC"
    ) as cursor:
        rows = await cursor.fetchall()
    # dict(row) converts aiosqlite.Row (a named-tuple-like object) to a plain
    # dict so Pydantic can validate it into the response model.
    return [dict(row) for row in rows]


@router.delete("/samples/{sample_id}", status_code=204)
async def delete_sample(
    sample_id: str,
    db: aiosqlite.Connection = Depends(get_db),
):
    """Delete a baseline writing sample by ID."""
    async with db.execute(
        "SELECT id FROM style_samples WHERE id = ?", (sample_id,)
    ) as cursor:
        row = await cursor.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Sample not found")

    await db.execute("DELETE FROM style_samples WHERE id = ?", (sample_id,))
    await db.commit()


@router.get("/score/{doc_id}", response_model=YounessScoreResponse)
async def get_score(
    doc_id: str,
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Compute the you-ness score for a document.

    1. Load and extract the document text.
    2. Compute the human/AI authorship breakdown from provenance events.
    3. Load the baseline samples.
    4. Call Claude to get the stylometric similarity score + explanation.

    If no samples have been uploaded, the endpoint still returns the
    provenance breakdown with score=0 and a message explaining what to do.
    """
    # 1. Load document content from the DB.
    async with db.execute(
        "SELECT content FROM documents WHERE id = ?", (doc_id,)
    ) as cursor:
        row = await cursor.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Document not found")

    try:
        doc_text = extract_text(json.loads(row["content"])).strip()
    except Exception:
        doc_text = ""

    if not doc_text:
        raise HTTPException(
            status_code=422,
            detail="Document is empty — write something first.",
        )

    # 2. Compute human vs AI authorship from provenance events.
    #
    # We sum the length of inserted_text per origin across all events for
    # this document. This is an approximation: it counts every insert, even
    # ones that were later deleted. But it gives a useful directional signal
    # without requiring us to replay the full edit history.
    async with db.execute(
        """
        SELECT origin, SUM(length(inserted_text)) AS chars
        FROM provenance_events
        WHERE document_id = ? AND inserted_text != ''
        GROUP BY origin
        """,
        (doc_id,),
    ) as cursor:
        origin_rows = await cursor.fetchall()

    human_chars = 0
    ai_chars = 0
    for r in origin_rows:
        if r["origin"] == "human":
            human_chars = r["chars"] or 0
        elif r["origin"] in ("ai_generated", "ai_modified"):
            ai_chars += r["chars"] or 0

    total_chars = human_chars + ai_chars
    if total_chars > 0:
        human_pct = round(human_chars / total_chars * 100, 1)
        ai_pct = round(ai_chars / total_chars * 100, 1)
    else:
        # No events recorded — assume everything is human-written.
        human_pct = 100.0
        ai_pct = 0.0

    # 3. Load the most recent baseline samples.
    async with db.execute(
        "SELECT filename, text FROM style_samples "
        "ORDER BY uploaded_at DESC "
        f"LIMIT {MAX_SAMPLES_IN_PROMPT}"
    ) as cursor:
        sample_rows = await cursor.fetchall()

    if not sample_rows:
        # No samples yet — return the provenance breakdown with a helpful message.
        return YounessScoreResponse(
            score=0,
            explanation=(
                "No baseline writing samples have been uploaded. "
                "Upload examples of your own writing to get a you-ness score."
            ),
            human_pct=human_pct,
            ai_pct=ai_pct,
            sample_count=0,
        )

    # 4. Call Claude to compute the stylometric score.
    client = _get_client()
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="ANTHROPIC_API_KEY is not configured. Add it to backend/.env.",
        )

    # Build the prompt: list each sample then the document to score.
    sample_blocks = []
    for i, s in enumerate(sample_rows, start=1):
        excerpt = s["text"][:MAX_CHARS_PER_SAMPLE]
        sample_blocks.append(f"--- Sample {i} ({s['filename']}) ---\n{excerpt}")

    user_message = (
        "BASELINE WRITING SAMPLES:\n\n"
        + "\n\n".join(sample_blocks)
        + "\n\n---\n\nDOCUMENT TO SCORE:\n\n"
        + doc_text
    )

    response = await client.messages.create(
        # Haiku is fast and cheap — this is a scoring task, not a generation task.
        model="claude-haiku-4-5-20251001",
        max_tokens=512,
        system=SCORE_SYSTEM_PROMPT,
        tools=[SCORE_TOOL],
        # tool_choice="any" forces Claude to call the tool (structured output).
        tool_choice={"type": "any"},
        messages=[{"role": "user", "content": user_message}],
    )

    # Extract the score and explanation from the tool_use block.
    score = 50
    explanation = "Score could not be computed."
    for block in response.content:
        if block.type == "tool_use" and block.name == "record_youness_score":
            score = int(block.input.get("score", 50))
            explanation = block.input.get("explanation", explanation)
            break

    return YounessScoreResponse(
        score=score,
        explanation=explanation,
        human_pct=human_pct,
        ai_pct=ai_pct,
        sample_count=len(sample_rows),
    )
