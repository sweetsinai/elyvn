"""
Followup tools — schedule and process multi-touch followup sequences.
Uses Claude for personalization with template fallback.
"""

import json
import logging
import os
from datetime import datetime, timedelta
from typing import Optional

import anthropic

from clients import get_client_kb, get_template
from db import (
    get_client,
    get_lead,
    insert_followup,
    get_due_followups,
    mark_followup_sent,
)

logger = logging.getLogger(__name__)


def _parse_appointment_time(t: Optional[str]) -> Optional[datetime]:
    if not t:
        return None
    try:
        return datetime.fromisoformat(t)
    except ValueError:
        return None


def _build_touch_schedule(
    trigger_event: str,
    now: datetime,
    appointment_time: Optional[datetime],
) -> list[dict]:
    """Return list of {touch_number, type, delta} based on trigger event."""
    if trigger_event == "booking_made":
        touches = [
            {"touch_number": 1, "type": "confirmation", "dt": now},
        ]
        if appointment_time:
            touches.append({
                "touch_number": 2,
                "type": "reminder",
                "dt": appointment_time - timedelta(hours=24),
            })
            touches.append({
                "touch_number": 3,
                "type": "review_request",
                "dt": appointment_time + timedelta(hours=24),
            })
        else:
            touches.append({"touch_number": 2, "type": "reminder", "dt": now + timedelta(hours=24)})
            touches.append({"touch_number": 3, "type": "review_request", "dt": now + timedelta(hours=72)})
        return touches

    elif trigger_event == "call_completed":
        return [
            {"touch_number": 1, "type": "thank_you", "dt": now},
            {"touch_number": 2, "type": "nudge", "dt": now + timedelta(hours=24)},
            {"touch_number": 3, "type": "final_nudge", "dt": now + timedelta(hours=72)},
        ]

    elif trigger_event == "message_replied":
        return [
            {"touch_number": 1, "type": "followup_check", "dt": now + timedelta(hours=24)},
        ]

    return []


async def _generate_content(
    touch_type: str,
    lead: dict,
    client_cfg: dict,
    kb: Optional[dict],
    service: Optional[str],
) -> tuple[str, str]:
    """Generate followup content. Returns (content, source)."""
    try:
        business_name = client_cfg.get("business_name", "our business")
        lead_name = lead.get("name", "there")
        lead_notes = lead.get("notes", "")

        try:
            client = anthropic.Anthropic()
            kb_text = json.dumps(kb, indent=2) if kb else "No knowledge base available."
            prompt = (
                f"Write a short, friendly {touch_type} SMS message for a customer.\n\n"
                f"Business: {business_name}\n"
                f"Customer name: {lead_name}\n"
                f"Service: {service or 'general'}\n"
                f"Context/notes: {lead_notes}\n"
                f"Knowledge base: {kb_text}\n\n"
                f"Keep it under 160 characters. Be warm but professional. "
                f"Return ONLY the message text, nothing else."
            )
            resp = client.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=200,
                messages=[{"role": "user", "content": prompt}],
            )
            return resp.content[0].text.strip(), "claude"

        except anthropic.APIError as e:
            logger.error("Claude followup generation failed: %s", e)
        except Exception as e:
            logger.error("Unexpected error in followup generation: %s", e)

        # Template fallback
        template = get_template(client_cfg.get("id", ""), f"{touch_type}.txt")
        if template:
            content = template.replace("{business_name}", str(business_name or '')).replace("{name}", str(lead_name or ''))
            return content, "template"

        # Hardcoded fallback
        fallbacks = {
            "confirmation": f"Hi {lead_name}! Your appointment with {business_name} is confirmed. We look forward to seeing you!",
            "reminder": f"Hi {lead_name}, just a reminder about your upcoming appointment with {business_name}. See you soon!",
            "review_request": f"Hi {lead_name}, thanks for choosing {business_name}! We'd love your feedback. How was your experience?",
            "thank_you": f"Thanks for calling {business_name}, {lead_name}! Let us know if you have any questions.",
            "nudge": f"Hi {lead_name}, we'd love to help you out at {business_name}. Ready to book an appointment?",
            "final_nudge": f"Hi {lead_name}, just checking in from {business_name}. We're here whenever you're ready!",
            "followup_check": f"Hi {lead_name}, just following up from {business_name}. Did you have any other questions?",
        }
        return fallbacks.get(touch_type, f"Hi from {business_name}! Let us know how we can help."), "template"
    except Exception as e:
        logger.error("_generate_content failed: %s", e)
        return f"Hi there! We'd love to help.", "error"


async def schedule_followup(
    lead_id: str,
    client_id: str,
    trigger_event: str,
    appointment_time: Optional[str] = None,
    service: Optional[str] = None,
) -> dict:
    """Schedule a multi-touch followup sequence for a lead."""
    try:
        lead = await get_lead(lead_id)
        if not lead:
            return {"error": f"Lead {lead_id} not found"}

        client_cfg = await get_client(client_id)
        if not client_cfg:
            return {"error": f"Client {client_id} not found"}

        kb = get_client_kb(client_id)
        now = datetime.utcnow()
        apt_dt = _parse_appointment_time(appointment_time)
        touches = _build_touch_schedule(trigger_event, now, apt_dt)

        followup_ids = []
        for touch in touches:
            try:
                content, source = await _generate_content(
                    touch["type"], lead, client_cfg, kb, service
                )
                fid = await insert_followup(
                    lead_id=lead_id,
                    client_id=client_id,
                    touch_number=touch["touch_number"],
                    type_=touch["type"],
                    content=content,
                    content_source=source,
                    scheduled_at=touch["dt"].isoformat(),
                )
                followup_ids.append(fid)
            except Exception as e:
                logger.error("Failed to insert followup for lead %s: %s", lead_id, e)
                continue

        return {
            "lead_id": lead_id,
            "trigger_event": trigger_event,
            "touches_scheduled": len(followup_ids),
            "followup_ids": followup_ids,
        }
    except Exception as e:
        logger.error("schedule_followup failed: %s", e)
        return {"error": f"Failed to schedule followup: {str(e)}"}


async def process_followup_queue() -> dict:
    """Process all due followups. Returns content for the bridge layer to send."""
    try:
        due = await get_due_followups()
        results = []

        for fu in due:
            try:
                await mark_followup_sent(fu["id"])
                results.append({
                    "followup_id": fu["id"],
                    "lead_id": fu["lead_id"],
                    "client_id": fu["client_id"],
                    "type": fu["type"],
                    "content": fu["content"],
                    "touch_number": fu["touch_number"],
                })
            except Exception as e:
                logger.error("Failed to mark followup %s as sent: %s", fu.get("id"), e)
                continue

        return {
            "processed": len(results),
            "followups": results,
        }
    except Exception as e:
        logger.error("process_followup_queue failed: %s", e)
        return {"error": f"Failed to process queue: {str(e)}"}
