"""
Scraper tool (Engine 2) — scrape business listings from Google Maps
and attempt to find email addresses from websites.
"""

import logging
import os
import re
from typing import Optional

import googlemaps
import httpx

from db import insert_prospect

logger = logging.getLogger(__name__)

GOOGLE_MAPS_API_KEY = os.environ.get("GOOGLE_MAPS_API_KEY", "")


async def scrape_businesses(
    industry: str,
    city: str,
    country: str = "US",
    max_results: int = 50,
) -> dict:
    """
    Scrape business listings using Google Maps Places API.
    Attempts to extract email from each business's website.
    """
    if not GOOGLE_MAPS_API_KEY:
        return {"error": "GOOGLE_MAPS_API_KEY not configured"}

    gmaps = googlemaps.Client(key=GOOGLE_MAPS_API_KEY)
    query = f"{industry} in {city}, {country}"

    scraped = 0
    with_emails = 0
    errors = 0

    try:
        results = gmaps.places(query=query)
        places = results.get("results", [])

        # Handle pagination up to max_results
        while len(places) < max_results and results.get("next_page_token"):
            import asyncio
            await asyncio.sleep(2)  # Google requires delay before next_page_token is valid
            results = gmaps.places(page_token=results["next_page_token"])
            places.extend(results.get("results", []))

        places = places[:max_results]

    except Exception as e:
        logger.error("Google Maps API error: %s", e)
        return {"error": f"Google Maps API error: {e}"}

    for place in places:
        try:
            place_id = place.get("place_id")
            details = {}
            if place_id:
                try:
                    details = gmaps.place(
                        place_id,
                        fields=["name", "formatted_phone_number", "website",
                                "formatted_address", "rating", "user_ratings_total",
                                "opening_hours"],
                    ).get("result", {})
                except Exception as e:
                    logger.warning("Failed to get details for %s: %s", place_id, e)

            name = details.get("name") or place.get("name", "Unknown")
            phone = details.get("formatted_phone_number")
            website = details.get("website")
            address = details.get("formatted_address") or place.get("formatted_address", "")
            rating = place.get("rating")
            review_count = details.get("user_ratings_total") or place.get("user_ratings_total")

            hours_data = details.get("opening_hours", {}).get("weekday_text", [])
            hours = "; ".join(hours_data) if hours_data else None

            # Parse state from address
            state = _extract_state(address, country)

            # Try to find email from website
            email = None
            if website:
                email = await _scrape_email_from_website(website)
                if email:
                    with_emails += 1

            await insert_prospect(
                business_name=name,
                phone=phone,
                email=email,
                website=website,
                address=address,
                industry=industry,
                city=city,
                state=state,
                country=country,
                rating=rating,
                review_count=review_count,
                hours=hours,
            )
            scraped += 1

        except Exception as e:
            logger.error("Error processing place %s: %s", place.get("name", "?"), e)
            errors += 1

    return {
        "query": query,
        "total_scraped": scraped,
        "with_emails": with_emails,
        "errors": errors,
    }


async def _scrape_email_from_website(url: str) -> Optional[str]:
    """Attempt to find an email address from a website's homepage."""
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=True) as http:
            resp = await http.get(url)
            resp.raise_for_status()
            html = resp.text

        # Look for mailto: links
        mailto_matches = re.findall(r'mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})', html)
        if mailto_matches:
            return mailto_matches[0].lower()

        # Look for email patterns in page text
        email_matches = re.findall(r'[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}', html)
        # Filter out common false positives
        filtered = [
            e.lower() for e in email_matches
            if not any(fp in e.lower() for fp in [
                "example.com", "wixpress", "sentry", "webpack",
                "googleapis", ".png", ".jpg", ".svg",
            ])
        ]
        if filtered:
            return filtered[0]

    except Exception as e:
        logger.debug("Failed to scrape email from %s: %s", url, e)

    return None


def _extract_state(address: str, country: str) -> Optional[str]:
    """Extract state abbreviation from a formatted address."""
    if country == "US":
        match = re.search(r',\s*([A-Z]{2})\s+\d{5}', address)
        if match:
            return match.group(1)
    return None
