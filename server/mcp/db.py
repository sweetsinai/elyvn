"""
SQLite database layer for ELYVN MCP server.
Uses aiosqlite for async access. All tables created on startup.
"""

import os
import uuid
import logging
from datetime import datetime
from typing import Optional

import aiosqlite

logger = logging.getLogger(__name__)

DB_PATH = os.environ.get("DATABASE_PATH", "./elyvn.db")

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    business_name TEXT NOT NULL,
    owner_name TEXT,
    owner_phone TEXT,
    owner_email TEXT,
    industry TEXT,
    avg_ticket REAL DEFAULT 0,
    retell_agent_id TEXT,
    retell_phone TEXT,
    twilio_phone TEXT,
    calcom_event_type_id TEXT,
    calcom_booking_link TEXT,
    telegram_chat_id TEXT,
    kb_path TEXT,
    template_path TEXT,
    timezone TEXT DEFAULT 'America/New_York',
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS calls (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    call_id TEXT,
    caller_phone TEXT,
    caller_name TEXT,
    direction TEXT DEFAULT 'inbound',
    duration INTEGER,
    outcome TEXT,
    calcom_booking_id TEXT,
    sentiment TEXT,
    summary TEXT,
    score INTEGER,
    transcript TEXT,
    analysis_data TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id)
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    lead_id TEXT,
    phone TEXT,
    channel TEXT DEFAULT 'sms',
    direction TEXT DEFAULT 'inbound',
    body TEXT,
    reply_text TEXT,
    reply_source TEXT DEFAULT 'claude',
    status TEXT DEFAULT 'received',
    message_sid TEXT,
    confidence TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id)
);

CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    name TEXT,
    phone TEXT NOT NULL,
    email TEXT,
    source TEXT,
    score INTEGER DEFAULT 0,
    stage TEXT DEFAULT 'new',
    last_contact TEXT,
    calcom_booking_id TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id)
);

CREATE TABLE IF NOT EXISTS followups (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    touch_number INTEGER NOT NULL,
    type TEXT,
    content TEXT,
    content_source TEXT DEFAULT 'claude',
    scheduled_at TEXT NOT NULL,
    sent_at TEXT,
    status TEXT DEFAULT 'scheduled',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (lead_id) REFERENCES leads(id),
    FOREIGN KEY (client_id) REFERENCES clients(id)
);

CREATE TABLE IF NOT EXISTS prospects (
    id TEXT PRIMARY KEY,
    business_name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    website TEXT,
    address TEXT,
    industry TEXT,
    city TEXT,
    state TEXT,
    country TEXT DEFAULT 'US',
    rating REAL,
    review_count INTEGER,
    hours TEXT,
    status TEXT DEFAULT 'scraped',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    industry TEXT,
    city TEXT,
    total_prospects INTEGER DEFAULT 0,
    total_sent INTEGER DEFAULT 0,
    total_replied INTEGER DEFAULT 0,
    total_positive INTEGER DEFAULT 0,
    total_booked INTEGER DEFAULT 0,
    status TEXT DEFAULT 'draft',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaign_prospects (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    prospect_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
    FOREIGN KEY (prospect_id) REFERENCES prospects(id)
);

CREATE TABLE IF NOT EXISTS emails_sent (
    id TEXT PRIMARY KEY,
    campaign_id TEXT,
    prospect_id TEXT,
    to_email TEXT,
    from_email TEXT,
    subject TEXT,
    body TEXT,
    sent_at TEXT,
    status TEXT DEFAULT 'draft',
    reply_text TEXT,
    reply_classification TEXT,
    reply_at TEXT,
    auto_response_sent INTEGER DEFAULT 0,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
    FOREIGN KEY (prospect_id) REFERENCES prospects(id)
);

CREATE TABLE IF NOT EXISTS weekly_reports (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    week_start TEXT NOT NULL,
    week_end TEXT NOT NULL,
    calls_answered INTEGER DEFAULT 0,
    calls_transferred INTEGER DEFAULT 0,
    messages_handled INTEGER DEFAULT 0,
    appointments_booked INTEGER DEFAULT 0,
    estimated_revenue REAL DEFAULT 0,
    missed_call_rate REAL DEFAULT 0,
    summary_text TEXT,
    sent_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id)
);
"""

INDEX_SQL = """
CREATE INDEX IF NOT EXISTS idx_calls_client_date ON calls(client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_client_date ON messages(client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_leads_client_stage ON leads(client_id, stage);
CREATE INDEX IF NOT EXISTS idx_followups_status_scheduled ON followups(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_prospects_status ON prospects(status);
CREATE INDEX IF NOT EXISTS idx_emails_campaign ON emails_sent(campaign_id, status);
"""


async def get_db() -> aiosqlite.Connection:
    """Return an aiosqlite connection with row_factory enabled."""
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA foreign_keys=ON")
    return db


async def init_db() -> None:
    """Create all tables and indexes if they don't exist."""
    db = await get_db()
    try:
        await db.executescript(SCHEMA_SQL)
        await db.executescript(INDEX_SQL)
        await db.commit()
        # Migrate: add telegram_chat_id if missing (safe for existing DBs)
        try:
            await db.execute("ALTER TABLE clients ADD COLUMN telegram_chat_id TEXT")
            await db.commit()
        except Exception:
            pass  # Column already exists
        logger.info("Database initialized at %s", DB_PATH)
    finally:
        await db.close()


# ---------------------------------------------------------------------------
# Query helpers
# ---------------------------------------------------------------------------

def _uid() -> str:
    return str(uuid.uuid4())


async def get_client(client_id: str) -> Optional[dict]:
    db = await get_db()
    try:
        cursor = await db.execute("SELECT * FROM clients WHERE id = ?", (client_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None
    finally:
        await db.close()


async def get_client_by_phone(phone: str) -> Optional[dict]:
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT * FROM clients WHERE retell_phone = ? AND is_active = 1", (phone,)
        )
        row = await cursor.fetchone()
        return dict(row) if row else None
    finally:
        await db.close()


async def get_all_active_clients() -> list[dict]:
    db = await get_db()
    try:
        cursor = await db.execute("SELECT * FROM clients WHERE is_active = 1")
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]
    finally:
        await db.close()


async def insert_call(
    client_id: str,
    call_id: str = None,
    caller_phone: str = None,
    caller_name: str = None,
    direction: str = "inbound",
    duration: int = None,
    outcome: str = None,
    calcom_booking_id: str = None,
    sentiment: str = None,
    summary: str = None,
    score: int = None,
) -> str:
    record_id = _uid()
    db = await get_db()
    try:
        await db.execute(
            """INSERT INTO calls
            (id, client_id, call_id, caller_phone, caller_name, direction,
             duration, outcome, calcom_booking_id, sentiment, summary, score)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (record_id, client_id, call_id, caller_phone, caller_name, direction,
             duration, outcome, calcom_booking_id, sentiment, summary, score),
        )
        await db.commit()
        return record_id
    finally:
        await db.close()


async def update_call(call_id: str, **kwargs) -> None:
    if not kwargs:
        return
    kwargs["updated_at"] = datetime.utcnow().isoformat()
    sets = ", ".join(f"{k} = ?" for k in kwargs)
    vals = list(kwargs.values()) + [call_id]
    db = await get_db()
    try:
        await db.execute(f"UPDATE calls SET {sets} WHERE id = ?", vals)
        await db.commit()
    finally:
        await db.close()


async def insert_message(
    client_id: str,
    phone: str = None,
    channel: str = "sms",
    direction: str = "inbound",
    body: str = None,
    reply_text: str = None,
    reply_source: str = "claude",
    status: str = "received",
) -> str:
    msg_id = _uid()
    db = await get_db()
    try:
        await db.execute(
            """INSERT INTO messages
            (id, client_id, phone, channel, direction, body,
             reply_text, reply_source, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (msg_id, client_id, phone, channel, direction, body,
             reply_text, reply_source, status),
        )
        await db.commit()
        return msg_id
    finally:
        await db.close()


async def upsert_lead(
    client_id: str,
    phone: str,
    name: str = None,
    email: str = None,
    source: str = None,
    score: int = None,
    stage: str = None,
    notes: str = None,
) -> str:
    """Insert or update a lead. Returns the lead ID."""
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT id, score FROM leads WHERE client_id = ? AND phone = ?",
            (client_id, phone),
        )
        existing = await cursor.fetchone()

        now = datetime.utcnow().isoformat()

        if existing:
            lead_id = existing["id"]
            updates = {"last_contact": now}
            if name:
                updates["name"] = name
            if email:
                updates["email"] = email
            if source:
                updates["source"] = source
            if score is not None:
                updates["score"] = max(score, existing["score"] or 0)
            if stage:
                updates["stage"] = stage
            if notes:
                updates["notes"] = notes
            sets = ", ".join(f"{k} = ?" for k in updates)
            vals = list(updates.values()) + [lead_id]
            await db.execute(f"UPDATE leads SET {sets} WHERE id = ?", vals)
        else:
            lead_id = _uid()
            await db.execute(
                """INSERT INTO leads
                (id, client_id, name, phone, email, source, score, stage, last_contact, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (lead_id, client_id, name, phone, email, source,
                 score or 0, stage or "new", now, notes),
            )

        await db.commit()
        return lead_id
    finally:
        await db.close()


async def get_lead(lead_id: str) -> Optional[dict]:
    db = await get_db()
    try:
        cursor = await db.execute("SELECT * FROM leads WHERE id = ?", (lead_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None
    finally:
        await db.close()


async def get_leads_by_stage(client_id: str, stage: str) -> list[dict]:
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT * FROM leads WHERE client_id = ? AND stage = ? ORDER BY last_contact DESC",
            (client_id, stage),
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]
    finally:
        await db.close()


async def insert_followup(
    lead_id: str,
    client_id: str,
    touch_number: int,
    type_: str,
    content: str,
    content_source: str,
    scheduled_at: str,
) -> str:
    fid = _uid()
    db = await get_db()
    try:
        await db.execute(
            """INSERT INTO followups
            (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (fid, lead_id, client_id, touch_number, type_, content, content_source, scheduled_at),
        )
        await db.commit()
        return fid
    finally:
        await db.close()


async def get_due_followups() -> list[dict]:
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT * FROM followups WHERE status = 'scheduled' AND scheduled_at <= datetime('now')"
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]
    finally:
        await db.close()


async def mark_followup_sent(followup_id: str) -> None:
    db = await get_db()
    try:
        await db.execute(
            "UPDATE followups SET status = 'sent', sent_at = datetime('now') WHERE id = ?",
            (followup_id,),
        )
        await db.commit()
    finally:
        await db.close()


async def insert_prospect(
    business_name: str,
    phone: str = None,
    email: str = None,
    website: str = None,
    address: str = None,
    industry: str = None,
    city: str = None,
    state: str = None,
    country: str = "US",
    rating: float = None,
    review_count: int = None,
    hours: str = None,
) -> str:
    pid = _uid()
    db = await get_db()
    try:
        await db.execute(
            """INSERT INTO prospects
            (id, business_name, phone, email, website, address, industry, city, state, country,
             rating, review_count, hours)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (pid, business_name, phone, email, website, address, industry, city, state, country,
             rating, review_count, hours),
        )
        await db.commit()
        return pid
    finally:
        await db.close()


async def get_prospect(prospect_id: str) -> Optional[dict]:
    db = await get_db()
    try:
        cursor = await db.execute("SELECT * FROM prospects WHERE id = ?", (prospect_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None
    finally:
        await db.close()


async def insert_campaign(
    name: str,
    industry: str = None,
    city: str = None,
) -> str:
    cid = _uid()
    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO campaigns (id, name, industry, city) VALUES (?, ?, ?, ?)",
            (cid, name, industry, city),
        )
        await db.commit()
        return cid
    finally:
        await db.close()


async def insert_email(
    campaign_id: str,
    prospect_id: str,
    subject: str,
    body: str,
    status: str = "draft",
    to_email: str = None,
    from_email: str = None,
) -> str:
    eid = _uid()
    db = await get_db()
    try:
        await db.execute(
            """INSERT INTO emails_sent
            (id, campaign_id, prospect_id, to_email, from_email, subject, body, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (eid, campaign_id, prospect_id, to_email, from_email, subject, body, status),
        )
        await db.commit()
        return eid
    finally:
        await db.close()


async def get_campaign_emails(campaign_id: str, status: str = None) -> list[dict]:
    db = await get_db()
    try:
        if status:
            cursor = await db.execute(
                "SELECT * FROM emails_sent WHERE campaign_id = ? AND status = ?",
                (campaign_id, status),
            )
        else:
            cursor = await db.execute(
                "SELECT * FROM emails_sent WHERE campaign_id = ?", (campaign_id,)
            )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]
    finally:
        await db.close()


async def update_email(email_id: str, **kwargs) -> None:
    if not kwargs:
        return
    kwargs["updated_at"] = datetime.utcnow().isoformat()
    sets = ", ".join(f"{k} = ?" for k in kwargs)
    vals = list(kwargs.values()) + [email_id]
    db = await get_db()
    try:
        await db.execute(f"UPDATE emails_sent SET {sets} WHERE id = ?", vals)
        await db.commit()
    finally:
        await db.close()


async def update_campaign(campaign_id: str, **kwargs) -> None:
    if not kwargs:
        return
    kwargs["updated_at"] = datetime.utcnow().isoformat()
    sets = ", ".join(f"{k} = ?" for k in kwargs)
    vals = list(kwargs.values()) + [campaign_id]
    db = await get_db()
    try:
        await db.execute(f"UPDATE campaigns SET {sets} WHERE id = ?", vals)
        await db.commit()
    finally:
        await db.close()


async def insert_weekly_report(
    client_id: str,
    week_start: str,
    week_end: str,
    calls_answered: int = 0,
    calls_transferred: int = 0,
    messages_handled: int = 0,
    appointments_booked: int = 0,
    estimated_revenue: float = 0,
    missed_call_rate: float = 0,
    summary_text: str = None,
) -> str:
    rid = _uid()
    db = await get_db()
    try:
        await db.execute(
            """INSERT INTO weekly_reports
            (id, client_id, week_start, week_end, calls_answered, calls_transferred,
             messages_handled, appointments_booked, estimated_revenue, missed_call_rate,
             summary_text, sent_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))""",
            (rid, client_id, week_start, week_end, calls_answered, calls_transferred,
             messages_handled, appointments_booked, estimated_revenue, missed_call_rate,
             summary_text),
        )
        await db.commit()
        return rid
    finally:
        await db.close()


async def query_calls_in_range(client_id: str, start: str, end: str) -> list[dict]:
    db = await get_db()
    try:
        cursor = await db.execute(
            """SELECT * FROM calls
            WHERE client_id = ? AND created_at >= ? AND created_at <= ?
            ORDER BY created_at DESC""",
            (client_id, start, end),
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]
    finally:
        await db.close()


async def query_messages_in_range(client_id: str, start: str, end: str) -> list[dict]:
    db = await get_db()
    try:
        cursor = await db.execute(
            """SELECT * FROM messages
            WHERE client_id = ? AND created_at >= ? AND created_at <= ?
            ORDER BY created_at DESC""",
            (client_id, start, end),
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]
    finally:
        await db.close()


async def update_client_telegram(client_id: str, chat_id: str) -> None:
    """Link a Telegram chat ID to a client."""
    db = await get_db()
    try:
        await db.execute(
            "UPDATE clients SET telegram_chat_id = ?, updated_at = datetime('now') WHERE id = ?",
            (chat_id, client_id),
        )
        await db.commit()
    finally:
        await db.close()


async def get_client_by_telegram(chat_id: str) -> Optional[dict]:
    """Look up a client by their Telegram chat ID."""
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT * FROM clients WHERE telegram_chat_id = ?", (chat_id,)
        )
        row = await cursor.fetchone()
        return dict(row) if row else None
    finally:
        await db.close()
