"""
Reply handler tools (Engine 2) — check IMAP inbox for replies and classify them.

DEPRECATED: Reply checking and classification is now handled by the Node.js bridge server:
  - scheduler.js checkReplies() — IMAP fetch every 30 min
  - outreach.js /auto-classify — Claude classification every 5 min
  - outreach.js /replies/:id/classify — manual classification

This file is kept for backward compatibility with existing MCP tool calls
but should NOT be used in parallel with the Node.js system to avoid
double-processing the same inbox messages.
"""

import email
import imaplib
import json
import logging
import os
import re
from typing import Optional

import anthropic

from db import update_email, get_db

logger = logging.getLogger(__name__)

IMAP_HOST = os.environ.get("IMAP_HOST", "imap.gmail.com")
IMAP_PORT = int(os.environ.get("IMAP_PORT", "993"))
IMAP_USER = os.environ.get("IMAP_USER", "")
IMAP_PASS = os.environ.get("IMAP_PASS", "")


async def check_for_replies() -> dict:
    """Check IMAP inbox for new replies and match them to sent emails."""
    if not IMAP_USER or not IMAP_PASS:
        return {"error": "IMAP credentials not configured"}

    matched = 0
    unmatched = 0
    errors = 0

    try:
        mail = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
        mail.login(IMAP_USER, IMAP_PASS)
        mail.select("INBOX")

        # Search for unseen messages
        status, message_ids = mail.search(None, "UNSEEN")
        if status != "OK" or not message_ids[0]:
            mail.logout()
            return {"matched": 0, "unmatched": 0, "errors": 0}

        ids = message_ids[0].split()

        for mid in ids:
            try:
                status, msg_data = mail.fetch(mid, "(RFC822)")
                if status != "OK":
                    errors += 1
                    continue

                raw = msg_data[0][1]
                msg = email.message_from_bytes(raw)

                # Extract reply text
                reply_text = _extract_body(msg)
                if not reply_text:
                    unmatched += 1
                    continue

                # Try to match via In-Reply-To header
                in_reply_to = msg.get("In-Reply-To", "")
                subject = msg.get("Subject", "")
                from_addr = msg.get("From", "")

                # Try to find the original email in our database
                email_id = await _match_reply_to_email(in_reply_to, subject, from_addr)

                if email_id:
                    await update_email(email_id, reply_text=reply_text)
                    matched += 1
                else:
                    unmatched += 1
                    logger.debug("Unmatched reply from %s: %s", from_addr, subject[:50])

            except Exception as e:
                logger.error("Error processing email %s: %s", mid, e)
                errors += 1

        mail.logout()

    except imaplib.IMAP4.error as e:
        logger.error("IMAP connection error: %s", e)
        return {"error": f"IMAP error: {e}"}
    except Exception as e:
        logger.error("Unexpected IMAP error: %s", e)
        return {"error": str(e)}

    return {
        "matched": matched,
        "unmatched": unmatched,
        "errors": errors,
    }


async def classify_reply(email_id: str) -> dict:
    """Classify a reply as INTERESTED / QUESTION / NOT_INTERESTED / UNSUBSCRIBE."""
    db = await get_db()
    try:
        cursor = await db.execute("SELECT * FROM emails_sent WHERE id = ?", (email_id,))
        row = await cursor.fetchone()
    finally:
        await db.close()

    if not row:
        return {"error": f"Email {email_id} not found"}

    email_record = dict(row)
    reply_text = email_record.get("reply_text")

    if not reply_text:
        return {"error": "No reply text to classify"}

    classification = None
    auto_action = None

    try:
        client = anthropic.Anthropic()
        resp = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=200,
            messages=[{
                "role": "user",
                "content": (
                    f"Classify this email reply into exactly one category.\n"
                    f"Categories: INTERESTED, QUESTION, NOT_INTERESTED, UNSUBSCRIBE\n\n"
                    f"Original subject: {email_record.get('subject', '')}\n"
                    f"Reply:\n{reply_text}\n\n"
                    f"Return JSON with:\n"
                    f"- classification: one of the four categories\n"
                    f"- auto_action: recommended next step"
                ),
            }],
        )

        result = resp.content[0].text.strip()
        try:
            parsed = json.loads(result)
            classification = parsed.get("classification", "QUESTION")
            auto_action = parsed.get("auto_action", "Review manually")
        except json.JSONDecodeError:
            # Try to extract classification from plain text
            text_upper = result.upper()
            if "INTERESTED" in text_upper and "NOT" not in text_upper:
                classification = "INTERESTED"
            elif "NOT_INTERESTED" in text_upper or "NOT INTERESTED" in text_upper:
                classification = "NOT_INTERESTED"
            elif "UNSUBSCRIBE" in text_upper:
                classification = "UNSUBSCRIBE"
            else:
                classification = "QUESTION"
            auto_action = "Review manually"

    except Exception as e:
        logger.error("Claude classification failed: %s", e)
        # Keyword fallback
        lower = reply_text.lower()
        if any(w in lower for w in ["unsubscribe", "remove me", "stop", "opt out"]):
            classification = "UNSUBSCRIBE"
            auto_action = "Remove from all campaigns"
        elif any(w in lower for w in ["not interested", "no thanks", "no thank you", "pass"]):
            classification = "NOT_INTERESTED"
            auto_action = "Mark as declined, do not contact again"
        elif any(w in lower for w in ["interested", "tell me more", "sounds good", "let's talk", "demo"]):
            classification = "INTERESTED"
            auto_action = "Send calendar link and follow up"
        else:
            classification = "QUESTION"
            auto_action = "Draft response to their question"

    await update_email(email_id, reply_classification=classification)

    return {
        "email_id": email_id,
        "classification": classification,
        "auto_action": auto_action,
        "reply_preview": reply_text[:200] if reply_text else None,
    }


def _extract_body(msg: email.message.Message) -> Optional[str]:
    """Extract plain text body from an email message."""
    if msg.is_multipart():
        for part in msg.walk():
            content_type = part.get_content_type()
            if content_type == "text/plain":
                payload = part.get_payload(decode=True)
                if payload:
                    return payload.decode("utf-8", errors="replace")
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            return payload.decode("utf-8", errors="replace")
    return None


async def _match_reply_to_email(
    in_reply_to: str,
    subject: str,
    from_addr: str,
) -> Optional[str]:
    """Try to match an incoming reply to a sent email record."""
    db = await get_db()
    try:
        # First try: match by subject (strip Re:/Fwd: prefixes)
        clean_subject = re.sub(r'^(Re:|Fwd?:)\s*', '', subject, flags=re.IGNORECASE).strip()
        if clean_subject:
            cursor = await db.execute(
                "SELECT es.id FROM emails_sent es "
                "JOIN prospects p ON es.prospect_id = p.id "
                "WHERE es.subject = ? AND es.status = 'sent' AND es.reply_text IS NULL "
                "LIMIT 1",
                (clean_subject,),
            )
            row = await cursor.fetchone()
            if row:
                return row["id"]

        # Second try: match by prospect email in from_addr
        email_match = re.search(r'[\w.+-]+@[\w.-]+\.\w+', from_addr)
        if email_match:
            from_email = email_match.group().lower()
            cursor = await db.execute(
                "SELECT es.id FROM emails_sent es "
                "JOIN prospects p ON es.prospect_id = p.id "
                "WHERE LOWER(p.email) = ? AND es.status = 'sent' AND es.reply_text IS NULL "
                "ORDER BY es.sent_at DESC LIMIT 1",
                (from_email,),
            )
            row = await cursor.fetchone()
            if row:
                return row["id"]

    finally:
        await db.close()

    return None
