"""
Edit classification for human provenance events.

Phase 5 adds two layers of classification:
1. Rule-based: deterministic checks that run synchronously.
2. Claude fallback: a lightweight Haiku API call for ambiguous cases.

Both layers mirror the frontend's classifier.ts rules so that in-session
heatmap decorations (frontend) and stored provenance records (backend)
agree for the cases the rule covers. Claude adds classification for the
ambiguous cases the rule can't handle.
"""

import re
import os

import anthropic

# Reuse the module-level lazy client pattern from suggestions.py.
# Each module has its own client so there are no import-order dependencies.
_client: anthropic.AsyncAnthropic | None = None


def _get_client() -> anthropic.AsyncAnthropic | None:
    """Return a client if ANTHROPIC_API_KEY is set, otherwise None."""
    global _client
    if _client is None:
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            return None
        _client = anthropic.AsyncAnthropic(api_key=api_key)
    return _client


def _strip(text: str) -> str:
    """Remove all non-word characters and lowercase — mirrors the frontend strip()."""
    return re.sub(r"[^\w]", "", text, flags=re.UNICODE).lower()


def _rule_based(inserted: str, deleted: str) -> str | None:
    """
    Apply deterministic rules to classify a replacement.

    Returns a classification string or None if the rules don't apply.

    Rules:
    - If stripping punctuation/whitespace/capitalisation from both sides
      gives the same string → "human_grammar_fix".
    - Pure inserts and pure deletes are not classifiable by rule.
    """
    if not inserted or not deleted:
        # Pure insert or pure delete: no rule-based classification.
        return None

    if _strip(inserted) == _strip(deleted):
        return "human_grammar_fix"

    return None


async def classify_human_edit(inserted: str, deleted: str) -> str | None:
    """
    Classify a human edit, trying rules first then Claude.

    Returns one of:
      "human_grammar_fix"
      "human_wording_change"
      "human_organizational_move"
      None   (if classification is not applicable or Claude is unavailable)

    This function is called for each provenance event that has
    origin="human" and edit_type=None after arriving at the backend.
    """
    # Rule-based pass (fast, no API call).
    result = _rule_based(inserted, deleted)
    if result is not None:
        return result

    # No rule matched. Only call Claude for meaningful replacements —
    # tiny edits (e.g. fixing one letter) don't need an API call.
    # Threshold: at least 5 chars on each side so we have enough context.
    if not inserted or not deleted:
        return None
    if len(inserted) < 5 or len(deleted) < 5:
        # Short replacement: call it a wording change without asking Claude.
        return "human_wording_change"

    return await _classify_with_claude(inserted, deleted)


async def _classify_with_claude(inserted: str, deleted: str) -> str:
    """
    Ask Claude Haiku to classify an ambiguous human edit.

    Uses the smallest, cheapest model because this is a simple 3-way
    classification task — we just need the label, not an explanation.

    Falls back to "human_wording_change" if the API is unavailable or
    returns an unexpected value, so a failed call never breaks provenance.
    """
    client = _get_client()
    if client is None:
        # API key not configured — degrade gracefully.
        return "human_wording_change"

    prompt = (
        f'Original text: "{deleted}"\n'
        f'Replacement text: "{inserted}"\n\n'
        "Classify this text edit into exactly one of these categories:\n"
        "- human_grammar_fix: correcting spelling, grammar, punctuation, or capitalisation\n"
        "- human_wording_change: rewording for clarity, tone, or style\n"
        "- human_organizational_move: moving or restructuring text\n\n"
        "Reply with only the category name, nothing else."
    )

    try:
        response = await client.messages.create(
            # Haiku is fast and cheap — right-sized for a single-label task.
            model="claude-haiku-4-5-20251001",
            max_tokens=20,
            messages=[{"role": "user", "content": prompt}],
        )
        label = response.content[0].text.strip()
        valid = {
            "human_grammar_fix",
            "human_wording_change",
            "human_organizational_move",
        }
        return label if label in valid else "human_wording_change"
    except Exception:
        # Network error, rate limit, etc. — don't break the provenance save.
        return "human_wording_change"
