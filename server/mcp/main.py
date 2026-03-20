"""
ELYVN MCP Server — FastMCP with streamable-http transport.
Registers all tools, initializes DB and client configs on startup.
"""

import logging
import sys
from contextlib import asynccontextmanager
from typing import Optional

from fastmcp import FastMCP

from db import init_db
from clients import load_all_kbs

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("elyvn")


@asynccontextmanager
async def lifespan(server: FastMCP):
    """Initialize database and load knowledge bases on startup."""
    logger.info("ELYVN MCP server starting up")
    await init_db()
    kb_count = await load_all_kbs()
    logger.info("Loaded %d knowledge bases", kb_count)
    logger.info("ELYVN MCP server ready")
    yield
    logger.info("ELYVN MCP server shutting down")


mcp = FastMCP("elyvn", lifespan=lifespan)

# ---------------------------------------------------------------------------
# Import tool functions
# ---------------------------------------------------------------------------
from tools.voice import handle_inbound_call, transfer_to_human, initiate_outbound_call
from tools.messaging import handle_missed_message
from tools.followup import schedule_followup, process_followup_queue
from tools.booking import check_calcom_bookings, cancel_booking
from tools.intelligence import score_lead, analyze_call
from tools.reporting import generate_weekly_report
from tools.scraper import scrape_businesses
from tools.outreach import write_cold_email, send_campaign
from tools.reply_handler import check_for_replies, classify_reply


# ---------------------------------------------------------------------------
# Register MCP tools
# ---------------------------------------------------------------------------

@mcp.tool()
async def tool_handle_inbound_call(
    call_id: str,
    caller_phone: str,
    duration: int,
    outcome: str,
    client_id: str,
    calcom_booking_id: Optional[str] = None,
) -> dict:
    """Post-call processing for inbound calls. Fetches transcript from Retell, generates summary, scores lead, upserts lead record."""
    return await handle_inbound_call(call_id, caller_phone, duration, outcome, client_id, calcom_booking_id)


@mcp.tool()
async def tool_transfer_to_human(
    call_id: str,
    caller_phone: str,
    client_id: str,
) -> dict:
    """Handle a call transfer — summarize transcript and log as transferred."""
    return await transfer_to_human(call_id, caller_phone, client_id)


@mcp.tool()
async def tool_initiate_outbound_call(
    contact_phone: str,
    purpose: str,
    client_id: str,
) -> dict:
    """Create an outbound call via Retell AI and log it in the database."""
    return await initiate_outbound_call(contact_phone, purpose, client_id)


@mcp.tool()
async def tool_handle_missed_message(
    message_text: str,
    sender_phone: str,
    client_id: str,
    channel: str = "sms",
) -> dict:
    """Auto-reply to an inbound message using client knowledge base and Claude. Falls back to template."""
    return await handle_missed_message(message_text, sender_phone, client_id, channel)


@mcp.tool()
async def tool_schedule_followup(
    lead_id: str,
    client_id: str,
    trigger_event: str,
    appointment_time: Optional[str] = None,
    service: Optional[str] = None,
) -> dict:
    """Schedule a multi-touch followup sequence for a lead based on trigger event (booking_made, call_completed, message_replied)."""
    return await schedule_followup(lead_id, client_id, trigger_event, appointment_time, service)


@mcp.tool()
async def tool_process_followup_queue() -> dict:
    """Process all due followups and return their content for the bridge layer to send."""
    return await process_followup_queue()


@mcp.tool()
async def tool_check_calcom_bookings(
    client_id: str,
    start_date: str,
    end_date: str,
) -> dict:
    """Fetch bookings from Cal.com for a client within a date range."""
    return await check_calcom_bookings(client_id, start_date, end_date)


@mcp.tool()
async def tool_cancel_booking(
    booking_id: str,
    reason: str,
) -> dict:
    """Cancel a Cal.com booking."""
    return await cancel_booking(booking_id, reason)


@mcp.tool()
async def tool_score_lead(
    text: str,
    client_id: str,
    interaction_type: str,
) -> dict:
    """Score a lead 1-10 based on interaction text. Uses Claude with rules-based fallback."""
    return await score_lead(text, client_id, interaction_type)


@mcp.tool()
async def tool_analyze_call(
    retell_call_id: str,
    client_id: str,
) -> dict:
    """Deep analysis of a call transcript — extracts intent, sentiment, topics, missed opportunities."""
    return await analyze_call(retell_call_id, client_id)


@mcp.tool()
async def tool_generate_weekly_report(
    client_id: str,
) -> dict:
    """Generate a weekly performance report covering calls, messages, bookings, and revenue for the last 7 days."""
    return await generate_weekly_report(client_id)


@mcp.tool()
async def tool_scrape_businesses(
    industry: str,
    city: str,
    country: str = "US",
    max_results: int = 50,
) -> dict:
    """Scrape business listings from Google Maps for a given industry and city. Attempts to find emails from websites."""
    return await scrape_businesses(industry, city, country, max_results)


@mcp.tool()
async def tool_write_cold_email(
    prospect_id: str,
) -> dict:
    """Generate a personalized cold email for a prospect using Claude."""
    return await write_cold_email(prospect_id)


@mcp.tool()
async def tool_send_campaign(
    campaign_id: str,
) -> dict:
    """Send all draft emails for a campaign with rate limiting and bounce handling."""
    return await send_campaign(campaign_id)


@mcp.tool()
async def tool_check_for_replies() -> dict:
    """Check IMAP inbox for new replies to sent emails and match them to records."""
    return await check_for_replies()


@mcp.tool()
async def tool_classify_reply(
    email_id: str,
) -> dict:
    """Classify a reply as INTERESTED / QUESTION / NOT_INTERESTED / UNSUBSCRIBE."""
    return await classify_reply(email_id)


# ---------------------------------------------------------------------------
# Health endpoint
# ---------------------------------------------------------------------------

@mcp.custom_route("/health", methods=["GET"])
async def health(request):
    from starlette.responses import JSONResponse
    return JSONResponse({"status": "ok", "service": "elyvn-mcp"})


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    mcp.run(transport="streamable-http", host="0.0.0.0", port=8000)
