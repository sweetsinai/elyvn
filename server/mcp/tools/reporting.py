"""
Reporting tools — generate weekly performance reports for clients.
"""

import json
import logging
from datetime import datetime, timedelta

import anthropic

from db import (
    get_client,
    query_calls_in_range,
    query_messages_in_range,
    insert_weekly_report,
)

logger = logging.getLogger(__name__)


async def generate_weekly_report(client_id: str) -> dict:
    """Generate a weekly performance report for a client covering the last 7 days."""
    try:
        client_cfg = await get_client(client_id)
        if not client_cfg:
            return {"error": f"Client {client_id} not found"}

        now = datetime.utcnow()
        week_end = now.strftime("%Y-%m-%d")
        week_start = (now - timedelta(days=7)).strftime("%Y-%m-%d")

        # Query data
        try:
            calls = await query_calls_in_range(client_id, week_start, week_end)
            messages = await query_messages_in_range(client_id, week_start, week_end)
        except Exception as e:
            logger.error("Failed to query data for report: %s", e)
            return {"error": f"Failed to query report data: {str(e)}"}

        # Calculate metrics
        calls_answered = len([c for c in calls if c.get("outcome") != "missed"])
        calls_transferred = len([c for c in calls if c.get("outcome") == "transferred"])
        calls_missed = len([c for c in calls if c.get("outcome") == "missed"])
        total_calls = len(calls)
        messages_handled = len(messages)

        bookings = len([c for c in calls if c.get("calcom_booking_id")])
        avg_ticket = client_cfg.get("avg_ticket", 0) or 0
        estimated_revenue = bookings * avg_ticket

        missed_call_rate = (calls_missed / total_calls * 100) if total_calls > 0 else 0

        # Build summary
        business_name = client_cfg.get("business_name", "Business")
        summary_text = None

        try:
            client = anthropic.Anthropic()
            stats_context = (
                f"Business: {business_name}\n"
                f"Week: {week_start} to {week_end}\n"
                f"Calls answered: {calls_answered}\n"
                f"Calls transferred: {calls_transferred}\n"
                f"Calls missed: {calls_missed}\n"
                f"Missed call rate: {missed_call_rate:.1f}%\n"
                f"Messages handled: {messages_handled}\n"
                f"Appointments booked: {bookings}\n"
                f"Estimated revenue: ${estimated_revenue:,.2f}\n"
            )
            resp = client.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=300,
                messages=[{
                    "role": "user",
                    "content": (
                        f"Write a 5-line executive summary for this weekly report. "
                        f"Be concise and data-driven. Highlight wins and areas for improvement.\n\n"
                        f"{stats_context}"
                    ),
                }],
            )
            summary_text = resp.content[0].text.strip()

        except anthropic.APIError as e:
            logger.error("Claude report summary failed: %s", e)
            summary_text = (
                f"Weekly Report for {business_name} ({week_start} to {week_end})\n"
                f"Calls answered: {calls_answered} | Transferred: {calls_transferred} | Missed rate: {missed_call_rate:.1f}%\n"
                f"Messages handled: {messages_handled}\n"
                f"Appointments booked: {bookings} | Est. revenue: ${estimated_revenue:,.2f}\n"
                f"{'Missed call rate is high — consider adjusting agent availability.' if missed_call_rate > 20 else 'Performance is within normal range.'}"
            )
        except Exception as e:
            logger.error("Unexpected error in report generation: %s", e)
            summary_text = (
                f"Weekly Report for {business_name} ({week_start} to {week_end})\n"
                f"Calls answered: {calls_answered} | Transferred: {calls_transferred} | Missed rate: {missed_call_rate:.1f}%\n"
                f"Messages handled: {messages_handled}\n"
                f"Appointments booked: {bookings} | Est. revenue: ${estimated_revenue:,.2f}\n"
                f"{'Missed call rate is high — consider adjusting agent availability.' if missed_call_rate > 20 else 'Performance is within normal range.'}"
            )

        try:
            report_id = await insert_weekly_report(
                client_id=client_id,
                week_start=week_start,
                week_end=week_end,
                calls_answered=calls_answered,
                calls_transferred=calls_transferred,
                messages_handled=messages_handled,
                appointments_booked=bookings,
                estimated_revenue=estimated_revenue,
                missed_call_rate=missed_call_rate,
                summary_text=summary_text,
            )
        except Exception as e:
            logger.error("Failed to insert report: %s", e)
            return {"error": f"Failed to save report: {str(e)}"}

        return {
            "report_id": report_id,
            "client_id": client_id,
            "week_start": week_start,
            "week_end": week_end,
            "calls_answered": calls_answered,
            "calls_transferred": calls_transferred,
            "calls_missed": calls_missed,
            "missed_call_rate": round(missed_call_rate, 1),
            "messages_handled": messages_handled,
            "appointments_booked": bookings,
            "estimated_revenue": estimated_revenue,
            "summary": summary_text,
        }
    except Exception as e:
        logger.error("generate_weekly_report failed: %s", e)
        return {"error": f"Failed to generate report: {str(e)}"}
