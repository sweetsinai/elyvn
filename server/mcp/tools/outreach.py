"""
Outreach tools (Engine 2) — cold email generation and campaign sending.
"""

import asyncio
import json
import logging
import os
import smtplib
from datetime import datetime
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

import anthropic

from db import (
    get_prospect,
    insert_email,
    get_campaign_emails,
    update_email,
    update_campaign,
)

logger = logging.getLogger(__name__)

SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASS = os.environ.get("SMTP_PASS", "")
FROM_EMAIL = os.environ.get("FROM_EMAIL", SMTP_USER)
CALCOM_BOOKING_LINK = os.environ.get("CALCOM_BOOKING_LINK", os.environ.get("MY_CALCOM_LINK", "https://cal.com/sohan/discovery"))

MAX_DAILY_SENDS = 30
MAX_PER_MINUTE = 2
CONSECUTIVE_BOUNCE_LIMIT = 3


async def write_cold_email(prospect_id: str) -> dict:
    """Generate a personalized cold email for a prospect using Claude."""
    try:
        prospect = await get_prospect(prospect_id)
        if not prospect:
            return {"error": f"Prospect {prospect_id} not found"}

        business_name = prospect.get("business_name", "your business")
        industry = prospect.get("industry", "")
        city = prospect.get("city", "")
        rating = prospect.get("rating")
        review_count = prospect.get("review_count")
        website = prospect.get("website", "")

        subject = None
        body = None

        try:
            client = anthropic.Anthropic()
            prompt = (
                f"Write a cold email to a business owner. Return JSON with 'subject' and 'body' keys.\n\n"
                f"Business: {business_name}\n"
                f"Industry: {industry}\n"
                f"City: {city}\n"
                f"Website: {website}\n"
                f"Rating: {rating}/5 ({review_count} reviews)\n\n"
                f"Email structure:\n"
                f"1. Opening: specific observation about their business (from the data above)\n"
                f"2. Pain point: how missed calls cost them customers\n"
                f"3. Value prop: AI phone answering that books appointments 24/7\n"
                f"4. CTA: Book a demo call at {CALCOM_BOOKING_LINK}\n\n"
                f"Tone: professional, concise, not salesy. Under 150 words.\n"
                f"Subject line: under 50 characters, personalized."
            )

            resp = client.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=500,
                messages=[{"role": "user", "content": prompt}],
            )

            result = resp.content[0].text.strip()
            try:
                parsed = json.loads(result)
                subject = parsed.get("subject", "")
                body = parsed.get("body", "")
            except json.JSONDecodeError:
                # Try to extract subject and body from plain text
                lines = result.split("\n", 1)
                subject = lines[0].replace("Subject:", "").strip()
                body = lines[1].strip() if len(lines) > 1 else result

        except anthropic.APIError as e:
            logger.error("Claude cold email generation failed: %s", e)
            subject = f"Quick question for {business_name}"
            body = (
                f"Hi,\n\n"
                f"I noticed {business_name} in {city} — great reviews!\n\n"
                f"Quick question: do you ever miss customer calls after hours or when you're busy?\n\n"
                f"We built an AI phone agent that answers calls 24/7, qualifies leads, "
                f"and books appointments directly on your calendar.\n\n"
                f"Would love to show you a quick demo: {CALCOM_BOOKING_LINK}\n\n"
                f"Best,\nThe ELYVN Team"
            )
        except Exception as e:
            logger.error("Unexpected error in cold email generation: %s", e)
            subject = f"Quick question for {business_name}"
            body = (
                f"Hi,\n\n"
                f"I noticed {business_name} in {city} — great reviews!\n\n"
                f"Quick question: do you ever miss customer calls after hours or when you're busy?\n\n"
                f"We built an AI phone agent that answers calls 24/7, qualifies leads, "
                f"and books appointments directly on your calendar.\n\n"
                f"Would love to show you a quick demo: {CALCOM_BOOKING_LINK}\n\n"
                f"Best,\nThe ELYVN Team"
            )

        email_id = await insert_email(
            campaign_id=None,
            prospect_id=prospect_id,
            subject=subject,
            body=body,
            status="draft",
        )

        return {
            "email_id": email_id,
            "prospect_id": prospect_id,
            "subject": subject,
            "body": body,
            "status": "draft",
        }
    except Exception as e:
        logger.error("write_cold_email failed: %s", e)
        return {"error": f"Failed to write cold email: {str(e)}"}


async def send_campaign(campaign_id: str) -> dict:
    """Send all draft emails for a campaign with rate limiting and bounce handling."""
    try:
        emails = await get_campaign_emails(campaign_id, status="draft")
        if not emails:
            return {"campaign_id": campaign_id, "error": "No draft emails to send"}

        if not SMTP_USER or not SMTP_PASS:
            return {"error": "SMTP credentials not configured"}

        sent_count = 0
        failed_count = 0
        consecutive_bounces = 0
        paused = False

        try:
            smtp = smtplib.SMTP(SMTP_HOST, SMTP_PORT)
            smtp.starttls()
            smtp.login(SMTP_USER, SMTP_PASS)
        except Exception as e:
            logger.error("SMTP connection failed: %s", e)
            return {"error": f"SMTP connection failed: {str(e)}"}

        try:
            for i, email in enumerate(emails):
                try:
                    if sent_count >= MAX_DAILY_SENDS:
                        logger.info("Daily send limit reached (%d)", MAX_DAILY_SENDS)
                        break

                    if consecutive_bounces >= CONSECUTIVE_BOUNCE_LIMIT:
                        logger.warning("Pausing campaign %s: %d consecutive bounces", campaign_id, consecutive_bounces)
                        await update_campaign(campaign_id, status="paused")
                        paused = True
                        break

                    # Rate limiting: max 2 per minute
                    if i > 0 and i % MAX_PER_MINUTE == 0:
                        await asyncio.sleep(60)

                    prospect = await get_prospect(email["prospect_id"]) if email.get("prospect_id") else None
                    to_email = prospect.get("email") if prospect else None

                    if not to_email:
                        await update_email(email["id"], status="skipped")
                        failed_count += 1
                        continue

                    try:
                        msg = MIMEMultipart()
                        msg["From"] = FROM_EMAIL
                        msg["To"] = to_email
                        msg["Subject"] = email.get("subject", "")
                        msg.attach(MIMEText(email.get("body", ""), "plain"))

                        smtp.send_message(msg)

                        now = datetime.utcnow().isoformat()
                        await update_email(email["id"], status="sent", sent_at=now)
                        sent_count += 1
                        consecutive_bounces = 0

                    except smtplib.SMTPRecipientsRefused:
                        logger.warning("Bounce: %s", to_email)
                        await update_email(email["id"], status="bounced")
                        consecutive_bounces += 1
                        failed_count += 1

                    except smtplib.SMTPException as e:
                        logger.error("SMTP error sending to %s: %s", to_email, e)
                        await update_email(email["id"], status="failed")
                        failed_count += 1
                except Exception as e:
                    logger.error("Error processing email %s: %s", email.get("id"), e)
                    failed_count += 1
                    continue

        finally:
            try:
                smtp.quit()
            except Exception:
                pass

        await update_campaign(
            campaign_id,
            total_sent=sent_count,
            status="paused" if paused else ("sent" if sent_count > 0 else "draft"),
        )

        return {
            "campaign_id": campaign_id,
            "sent": sent_count,
            "failed": failed_count,
            "paused": paused,
        }
    except Exception as e:
        logger.error("send_campaign failed: %s", e)
        return {"error": f"Failed to send campaign: {str(e)}"}
