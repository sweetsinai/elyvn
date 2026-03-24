"""
Voice tools — post-call processing, transfers, and outbound calls.
Integrates with Retell AI for call data and Anthropic for analysis.
"""

import json
import logging
import os
from typing import Optional

import anthropic
import httpx

from db import insert_call, upsert_lead, get_client

logger = logging.getLogger(__name__)

RETELL_API_KEY = os.environ.get("RETELL_API_KEY", "")
RETELL_BASE = "https://api.retellai.com/v2"


async def _fetch_retell_call(retell_call_id: str) -> Optional[dict]:
    """Fetch call data (including transcript) from Retell AI."""
    try:
        async with httpx.AsyncClient(timeout=15) as http:
            resp = await http.get(
                f"{RETELL_BASE}/get-call/{retell_call_id}",
                headers={"Authorization": f"Bearer {RETELL_API_KEY}"},
            )
            resp.raise_for_status()
            return resp.json()
    except httpx.HTTPError as e:
        logger.error("Retell API error fetching call %s: %s", retell_call_id, e)
        return None


def _extract_transcript_text(retell_data: dict) -> str:
    """Extract readable transcript from Retell call data."""
    transcript = retell_data.get("transcript", "")
    if isinstance(transcript, list):
        lines = []
        for turn in transcript:
            role = turn.get("role", "unknown")
            content = turn.get("content", "")
            lines.append(f"{role}: {content}")
        return "\n".join(lines)
    return str(transcript)


async def handle_inbound_call(
    call_id: str,
    caller_phone: str,
    duration: int,
    outcome: str,
    client_id: str,
    calcom_booking_id: Optional[str] = None,
) -> dict:
    """Post-call processing for inbound calls. Fetches transcript, summarizes, scores lead."""
    try:
        retell_data = await _fetch_retell_call(call_id)
        transcript_text = _extract_transcript_text(retell_data) if retell_data else ""

        summary = "Call completed — transcript unavailable."
        score = 5
        sentiment = "neutral"

        if transcript_text:
            try:
                client = anthropic.Anthropic()
                resp = client.messages.create(
                    model="claude-sonnet-4-20250514",
                    max_tokens=300,
                    messages=[{
                        "role": "user",
                        "content": (
                            f"Analyze this call transcript and return JSON with exactly these keys:\n"
                            f"- summary: 2-sentence summary of the call\n"
                            f"- score: lead quality 1-10 (10 = ready to buy)\n"
                            f"- sentiment: positive/neutral/negative\n\n"
                            f"Transcript:\n{transcript_text}"
                        ),
                    }],
                )
                result_text = resp.content[0].text
                try:
                    parsed = json.loads(result_text)
                    summary = parsed.get("summary", summary)
                    score = int(parsed.get("score", score))
                    sentiment = parsed.get("sentiment", sentiment)
                except (json.JSONDecodeError, ValueError):
                    summary = result_text[:500]
            except anthropic.APIError as e:
                logger.error("Anthropic call analysis failed: %s", e)
            except Exception as e:
                logger.error("Unexpected error in call analysis: %s", e)

        client_cfg = await get_client(client_id)
        stage = "booked" if calcom_booking_id else ("qualified" if score >= 7 else "new")

        lead_id = await upsert_lead(
            client_id=client_id,
            phone=caller_phone,
            source="inbound_call",
            score=score,
            stage=stage,
            notes=summary,
        )

        await insert_call(
            client_id=client_id,
            call_id=call_id,
            caller_phone=caller_phone,
            direction="inbound",
            duration=duration,
            outcome=outcome,
            calcom_booking_id=calcom_booking_id,
            sentiment=sentiment,
            summary=summary,
            score=score,
        )

        return {
            "summary": summary,
            "score": score,
            "sentiment": sentiment,
            "lead_id": lead_id,
            "stage": stage,
        }
    except Exception as e:
        logger.error("handle_inbound_call failed: %s", e)
        return {"error": f"Failed to process inbound call: {str(e)}"}


async def transfer_to_human(
    call_id: str,
    caller_phone: str,
    client_id: str,
) -> dict:
    """Handle call transfer — fetch transcript, summarize, log as transferred."""
    try:
        retell_data = await _fetch_retell_call(call_id)
        transcript_text = _extract_transcript_text(retell_data) if retell_data else ""

        summary = "Call transferred to owner — transcript unavailable."

        if transcript_text:
            try:
                client = anthropic.Anthropic()
                resp = client.messages.create(
                    model="claude-sonnet-4-20250514",
                    max_tokens=150,
                    messages=[{
                        "role": "user",
                        "content": (
                            f"Summarize this call in exactly 2 sentences. "
                            f"Focus on what the caller needs:\n\n{transcript_text}"
                        ),
                    }],
                )
                summary = resp.content[0].text.strip()
            except anthropic.APIError as e:
                logger.error("Anthropic summarization failed: %s", e)
            except Exception as e:
                logger.error("Unexpected error in summarization: %s", e)

        await insert_call(
            client_id=client_id,
            call_id=call_id,
            caller_phone=caller_phone,
            direction="inbound",
            outcome="transferred",
            summary=summary,
        )

        return {"summary": summary, "call_id": call_id, "status": "transferred"}
    except Exception as e:
        logger.error("transfer_to_human failed: %s", e)
        return {"error": f"Failed to transfer call: {str(e)}"}


async def initiate_outbound_call(
    contact_phone: str,
    purpose: str,
    client_id: str,
) -> dict:
    """Create an outbound call via Retell AI and log it."""
    try:
        client_cfg = await get_client(client_id)
        if not client_cfg:
            return {"error": f"Client {client_id} not found"}

        agent_id = client_cfg.get("retell_agent_id")
        from_phone = client_cfg.get("retell_phone")
        if not agent_id or not from_phone:
            return {"error": "Client missing retell_agent_id or retell_phone"}

        retell_call_id = None
        try:
            async with httpx.AsyncClient(timeout=15) as http:
                resp = await http.post(
                    f"{RETELL_BASE}/create-phone-call",
                    headers={
                        "Authorization": f"Bearer {RETELL_API_KEY}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "from_number": from_phone,
                        "to_number": contact_phone,
                        "agent_id": agent_id,
                        "metadata": {"purpose": purpose, "client_id": client_id},
                    },
                )
                resp.raise_for_status()
                data = resp.json()
                retell_call_id = data.get("call_id")
        except httpx.HTTPError as e:
            logger.error("Retell outbound call failed: %s", e)
            return {"error": f"Retell API error: {str(e)}"}

        call_record_id = await insert_call(
            client_id=client_id,
            call_id=retell_call_id,
            caller_phone=contact_phone,
            direction="outbound",
            outcome="initiated",
            summary=purpose,
        )

        return {
            "retell_call_id": retell_call_id,
            "call_record_id": call_record_id,
            "status": "initiated",
        }
    except Exception as e:
        logger.error("initiate_outbound_call failed: %s", e)
        return {"error": f"Failed to initiate outbound call: {str(e)}"}
