"""Seed the ELYVN database with WeBrakes client and sample data."""

import asyncio
import sys
import os
from datetime import datetime, timedelta

# Ensure we can import from the same directory
sys.path.insert(0, os.path.dirname(__file__))

from db import (
    init_db, get_db, _uid,
    insert_call, insert_message, upsert_lead, insert_followup,
)


async def seed():
    """Seed the database with WeBrakes client and sample data."""
    await init_db()
    db = await get_db()

    try:
        # Check if already seeded
        cursor = await db.execute("SELECT id FROM clients WHERE id = 'webrakes'")
        if await cursor.fetchone():
            print("Database already seeded. Delete elyvn.db and re-run to reseed.")
            return

        # 1. Insert WeBrakes client
        await db.execute("""
            INSERT INTO clients (
                id, business_name, owner_name, owner_phone, owner_email,
                industry, avg_ticket, retell_agent_id, retell_phone, twilio_phone,
                calcom_event_type_id, calcom_booking_link, telegram_chat_id,
                kb_path, template_path, timezone, is_active
            ) VALUES (
                'webrakes', 'WeBrakes - Mobile Brake Repairs', 'Alex',
                '+18555261514', 'team@webrakes.com',
                'auto_repair', 170.0, '', '', '',
                '', '', NULL,
                'knowledge_bases/webrakes.json', 'templates/webrakes/',
                'America/New_York', 1
            )
        """)
        await db.commit()
        print("Inserted WeBrakes client")

        # 2. Insert sample leads
        leads = [
            ("lead-001", "Maria Johnson", "+12155551001", "call", 9, "booked"),
            ("lead-002", "James Wilson", "+12155551002", "call", 5, "contacted"),
            ("lead-003", "Sarah Chen", "+12155551003", "call", 3, "contacted"),
            ("lead-004", "David Park", "+12155551004", "call", 8, "booked"),
            ("lead-005", None, "+12155552001", "sms", 6, "new"),
        ]
        for lid, name, phone, source, score, stage in leads:
            await db.execute("""
                INSERT INTO leads (id, client_id, name, phone, source, score, stage, last_contact)
                VALUES (?, 'webrakes', ?, ?, ?, ?, ?, datetime('now'))
            """, (lid, name, phone, source, score, stage))
        await db.commit()
        print(f"Inserted {len(leads)} sample leads")

        # 3. Insert sample calls
        calls = [
            ("+12155551001", "Maria Johnson", 180, "booked", "positive",
             "Needs front brake pads for 2019 Honda Civic. Booked for tomorrow 10 AM at her office.", 9),
            ("+12155551002", "James Wilson", 120, "info_provided", "neutral",
             "Asked about pricing for rear brakes on 2021 Toyota Camry. Said he'd call back.", 5),
            ("+12155551003", "Sarah Chen", 90, "transferred", "negative",
             "Had a complaint about a previous service. Transferred to Alex.", 3),
            ("+12155551004", "David Park", 210, "booked", "positive",
             "Brake fluid flush + front pad replacement for 2020 BMW 330i. Booked Friday 2 PM.", 8),
            ("+12155551005", None, 45, "missed", None,
             "Caller hung up before AI could engage.", 0),
        ]
        for i, (phone, name, dur, outcome, sent, summary, score) in enumerate(calls):
            call_id = _uid()
            ts = (datetime.utcnow() - timedelta(hours=i*12)).isoformat()
            await db.execute("""
                INSERT INTO calls (id, client_id, call_id, caller_phone, caller_name, direction,
                    duration, outcome, sentiment, summary, score, created_at)
                VALUES (?, 'webrakes', ?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?)
            """, (call_id, f"retell-{call_id[:8]}", phone, name, dur, outcome, sent, summary, score, ts))
        await db.commit()
        print(f"Inserted {len(calls)} sample calls")

        # 4. Insert sample messages
        msgs = [
            ("+12155552001", "How much for rear brakes on a 2020 Camry?",
             "Rear brake pads for a 2020 Camry: $179.99+tax. Takes about 45-60 min. Want me to book you in?",
             "claude", "auto_replied", "high"),
            ("+12155552002", "Do you work on Saturdays?",
             "Yes! WeBrakes is open 7 days a week, 7 AM to 7 PM. Want to schedule this Saturday?",
             "claude", "auto_replied", "high"),
            ("+12155552003", "Can you fix my transmission?",
             "Great question! Let me have Alex get back to you on that.",
             "claude", "escalated", "low"),
        ]
        for phone, body_text, reply, source, status, conf in msgs:
            msg_id = _uid()
            await db.execute("""
                INSERT INTO messages (id, client_id, phone, channel, direction, body,
                    reply_text, reply_source, status, confidence, created_at)
                VALUES (?, 'webrakes', ?, 'sms', 'inbound', ?, ?, ?, ?, ?, datetime('now'))
            """, (msg_id, phone, body_text, reply, source, status, conf))
        await db.commit()
        print(f"Inserted {len(msgs)} sample messages")

        # 5. Insert sample follow-ups
        now = datetime.utcnow()
        await db.execute("""
            INSERT INTO followups (id, lead_id, client_id, touch_number, type, content,
                content_source, scheduled_at, sent_at, status)
            VALUES (?, 'lead-001', 'webrakes', 1, 'confirmation',
                'Your brake service is booked for tomorrow at 10 AM. Reply CANCEL to cancel.',
                'claude', ?, ?, 'sent')
        """, (_uid(), (now - timedelta(hours=2)).isoformat(), (now - timedelta(hours=2)).isoformat()))

        await db.execute("""
            INSERT INTO followups (id, lead_id, client_id, touch_number, type, content,
                content_source, scheduled_at, status)
            VALUES (?, 'lead-001', 'webrakes', 2, 'reminder',
                'Reminder: your brake pad replacement is today at 10 AM!',
                'template', ?, 'scheduled')
        """, (_uid(), (now + timedelta(hours=22)).isoformat()))
        await db.commit()
        print("Inserted 2 sample follow-ups")

        print("\nSeed complete! Database ready at elyvn.db")

    finally:
        await db.close()


if __name__ == "__main__":
    asyncio.run(seed())
