"""
Messaging tools — auto-reply to missed SMS/messages using client KB + Claude.
Falls back to templates when Claude is unavailable.
"""

import json
import logging
import os

import anthropic

from clients import get_client_kb, get_template
from db import insert_message, upsert_lead, get_client

logger = logging.getLogger(__name__)


async def handle_missed_message(
    message_text: str,
    sender_phone: str,
    client_id: str,
    channel: str = "sms",
) -> dict:
    """
    Generate an auto-reply for an inbound message using client KB + Claude.
    Falls back to a template if Claude is unavailable.
    """
    client_cfg = await get_client(client_id)
    business_name = client_cfg.get("business_name", "our business") if client_cfg else "our business"
    kb = get_client_kb(client_id)

    reply_text = None
    reply_source = "template"
    status = "replied"
    confidence = "high"

    if kb:
        try:
            client = anthropic.Anthropic()
            system_prompt = (
                f"You are the AI assistant for {business_name}. "
                f"Answer the customer's question using ONLY the following knowledge base. "
                f"If the answer is not in the KB, say so honestly.\n\n"
                f"Knowledge Base:\n{json.dumps(kb, indent=2)}\n\n"
                f"Return your response as JSON with two keys:\n"
                f"- reply: your response text to the customer\n"
                f"- confidence: 'high' if answer is clearly in KB, 'low' if uncertain"
            )

            resp = client.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=400,
                system=system_prompt,
                messages=[{"role": "user", "content": message_text}],
            )

            result_text = resp.content[0].text.strip()
            try:
                parsed = json.loads(result_text)
                reply_text = parsed.get("reply", result_text)
                confidence = parsed.get("confidence", "low")
                reply_source = "claude"
            except json.JSONDecodeError:
                reply_text = result_text
                reply_source = "claude"
                confidence = "low"

        except Exception as e:
            logger.error("Claude messaging failed for client %s: %s", client_id, e)
            reply_text = None

    # Fallback to template
    if not reply_text:
        template = get_template(client_id, "fallback_reply.txt")
        if template:
            reply_text = template.replace("{business_name}", business_name)
        else:
            reply_text = (
                f"Thank you for reaching out to {business_name}! "
                f"We received your message and will get back to you shortly."
            )
        reply_source = "template"
        confidence = "high"

    # Escalate low-confidence replies
    if confidence == "low":
        status = "escalated"

    lead_id = await upsert_lead(
        client_id=client_id,
        phone=sender_phone,
        source=f"inbound_{channel}",
    )

    msg_id = await insert_message(
        client_id=client_id,
        phone=sender_phone,
        channel=channel,
        direction="inbound",
        body=message_text,
        reply_text=reply_text,
        reply_source=reply_source,
        status=status,
    )

    return {
        "reply_text": reply_text,
        "reply_source": reply_source,
        "confidence": confidence,
        "lead_id": lead_id,
        "message_id": msg_id,
        "status": status,
    }
