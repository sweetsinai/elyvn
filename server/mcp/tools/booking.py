"""
Booking tools — check and cancel Cal.com bookings.
Cal.com is the source of truth for appointments; we only store booking_id references.
"""

import logging
import os

import httpx

from db import get_client, upsert_lead

logger = logging.getLogger(__name__)

CALCOM_API_KEY = os.environ.get("CALCOM_API_KEY", "")
CALCOM_BASE = "https://api.cal.com/v2"


async def check_calcom_bookings(
    client_id: str,
    start_date: str,
    end_date: str,
) -> dict:
    """Fetch bookings from Cal.com for a given client and date range."""
    client_cfg = await get_client(client_id)
    if not client_cfg:
        return {"error": f"Client {client_id} not found"}

    event_type_id = client_cfg.get("calcom_event_type_id")
    if not event_type_id:
        return {"error": "Client has no calcom_event_type_id configured"}

    try:
        async with httpx.AsyncClient(timeout=15) as http:
            resp = await http.get(
                f"{CALCOM_BASE}/bookings",
                headers={
                    "Authorization": f"Bearer {CALCOM_API_KEY}",
                    "Content-Type": "application/json",
                },
                params={
                    "eventTypeId": event_type_id,
                    "afterStart": start_date,
                    "beforeEnd": end_date,
                },
            )
            resp.raise_for_status()
            data = resp.json()

        bookings = data.get("data", data.get("bookings", []))
        return {
            "client_id": client_id,
            "start_date": start_date,
            "end_date": end_date,
            "total": len(bookings),
            "bookings": bookings,
        }

    except httpx.HTTPError as e:
        logger.error("Cal.com API error: %s", e)
        return {"error": f"Cal.com API error: {e}"}


async def cancel_booking(
    booking_id: str,
    reason: str,
) -> dict:
    """Cancel a Cal.com booking and update lead stage."""
    try:
        async with httpx.AsyncClient(timeout=15) as http:
            resp = await http.delete(
                f"{CALCOM_BASE}/bookings/{booking_id}",
                headers={
                    "Authorization": f"Bearer {CALCOM_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={"cancellationReason": reason},
            )
            resp.raise_for_status()

        return {
            "booking_id": booking_id,
            "status": "cancelled",
            "reason": reason,
        }

    except httpx.HTTPStatusError as e:
        logger.error("Cal.com cancel failed (HTTP %s): %s", e.response.status_code, e)
        return {
            "booking_id": booking_id,
            "status": "failed",
            "error": f"HTTP {e.response.status_code}: {e.response.text}",
        }
    except httpx.HTTPError as e:
        logger.error("Cal.com cancel error: %s", e)
        return {
            "booking_id": booking_id,
            "status": "failed",
            "error": str(e),
        }
