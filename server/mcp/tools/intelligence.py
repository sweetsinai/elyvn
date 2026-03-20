"""
Intelligence tools — lead scoring and call analysis.
Claude-powered with rules-based fallback for scoring.
"""

import json
import logging
import os
import re
from typing import Optional

import anthropic
import httpx

from db import get_client, update_call

logger = logging.getLogger(__name__)

RETELL_API_KEY = os.environ.get("RETELL_API_KEY", "")
RETELL_BASE = "https://api.retellai.com/v2"


def _rules_based_score(text: str) -> tuple[int, str, str]:
    """Fallback lead scoring using keyword rules."""
    text_lower = text.lower()

    urgency_keywords = ["today", "asap", "emergency", "right now", "urgent", "immediately"]
    budget_keywords = ["how much", "price", "cost", "quote", "estimate", "rate"]
    cold_keywords = ["just looking", "browsing", "maybe later", "not sure", "no thanks"]

    for kw in urgency_keywords:
        if kw in text_lower:
            return 8, f"High urgency detected: '{kw}'", "Follow up immediately — hot lead"

    for kw in budget_keywords:
        if kw in text_lower:
            return 6, f"Budget inquiry detected: '{kw}'", "Send pricing info and follow up within 2 hours"

    for kw in cold_keywords:
        if kw in text_lower:
            return 3, f"Low intent detected: '{kw}'", "Add to nurture sequence"

    return 5, "No strong signals detected", "Standard follow-up within 24 hours"


async def score_lead(
    text: str,
    client_id: str,
    interaction_type: str,
) -> dict:
    """Score a lead 1-10 based on interaction text. Uses Claude with rules-based fallback."""
    client_cfg = await get_client(client_id)
    business_name = client_cfg.get("business_name", "business") if client_cfg else "business"
    industry = client_cfg.get("industry", "services") if client_cfg else "services"

    try:
        client = anthropic.Anthropic()
        resp = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=300,
            messages=[{
                "role": "user",
                "content": (
                    f"Score this lead for a {industry} business called {business_name}.\n"
                    f"Interaction type: {interaction_type}\n\n"
                    f"Text:\n{text}\n\n"
                    f"Analyze: urgency, budget signals, timeline, service match.\n"
                    f"Return JSON with:\n"
                    f"- score: integer 1-10 (10 = ready to buy)\n"
                    f"- reasoning: 1-sentence explanation\n"
                    f"- recommended_action: what the business should do next"
                ),
            }],
        )
        result = resp.content[0].text.strip()
        try:
            parsed = json.loads(result)
            return {
                "score": int(parsed.get("score", 5)),
                "reasoning": parsed.get("reasoning", ""),
                "recommended_action": parsed.get("recommended_action", ""),
                "source": "claude",
            }
        except (json.JSONDecodeError, ValueError):
            return {
                "score": 5,
                "reasoning": result[:200],
                "recommended_action": "Review manually",
                "source": "claude",
            }

    except Exception as e:
        logger.error("Claude scoring failed: %s", e)

    score, reasoning, action = _rules_based_score(text)
    return {
        "score": score,
        "reasoning": reasoning,
        "recommended_action": action,
        "source": "rules",
    }


async def analyze_call(
    retell_call_id: str,
    client_id: str,
) -> dict:
    """Deep analysis of a call transcript via Claude. Extracts intent, sentiment, topics."""
    # Fetch transcript from Retell
    transcript_text = ""
    try:
        async with httpx.AsyncClient(timeout=15) as http:
            resp = await http.get(
                f"{RETELL_BASE}/get-call/{retell_call_id}",
                headers={"Authorization": f"Bearer {RETELL_API_KEY}"},
            )
            resp.raise_for_status()
            retell_data = resp.json()

        transcript = retell_data.get("transcript", "")
        if isinstance(transcript, list):
            lines = [f"{t.get('role', 'unknown')}: {t.get('content', '')}" for t in transcript]
            transcript_text = "\n".join(lines)
        else:
            transcript_text = str(transcript)
    except httpx.HTTPError as e:
        logger.error("Retell fetch failed for call %s: %s", retell_call_id, e)
        return {"error": f"Failed to fetch transcript: {e}"}

    if not transcript_text:
        return {"error": "No transcript available"}

    try:
        client = anthropic.Anthropic()
        resp = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=500,
            messages=[{
                "role": "user",
                "content": (
                    f"Analyze this call transcript and return JSON with:\n"
                    f"- intent: what the caller wanted (1 sentence)\n"
                    f"- info_captured: list of key info gathered (name, service needed, etc)\n"
                    f"- missed_opportunities: list of things the agent should have asked/offered\n"
                    f"- sentiment: positive/neutral/negative\n"
                    f"- topics: list of main topics discussed\n\n"
                    f"Transcript:\n{transcript_text}"
                ),
            }],
        )

        result = resp.content[0].text.strip()
        try:
            analysis = json.loads(result)
        except json.JSONDecodeError:
            analysis = {
                "intent": result[:200],
                "info_captured": [],
                "missed_opportunities": [],
                "sentiment": "neutral",
                "topics": [],
            }

        # Update call record with analysis results
        db = await _find_call_by_call_id(retell_call_id)
        if db:
            await update_call(
                db["id"],
                sentiment=analysis.get("sentiment", "neutral"),
                summary=analysis.get("intent", ""),
            )

        return {
            "retell_call_id": retell_call_id,
            "analysis": analysis,
        }

    except Exception as e:
        logger.error("Claude call analysis failed: %s", e)
        return {"error": f"Analysis failed: {e}"}


async def _find_call_by_call_id(call_id: str) -> Optional[dict]:
    """Look up a call record by call ID."""
    import aiosqlite
    from db import get_db

    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT * FROM calls WHERE call_id = ?", (call_id,)
        )
        row = await cursor.fetchone()
        return dict(row) if row else None
    finally:
        await db.close()
