"""
Pydantic models for ELYVN MCP server.
Data models and tool input schemas.
"""

from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------

class ClientConfig(BaseModel):
    id: str
    business_name: str
    owner_name: Optional[str] = None
    owner_phone: Optional[str] = None
    owner_email: Optional[str] = None
    industry: Optional[str] = None
    avg_ticket: float = 0
    retell_agent_id: Optional[str] = None
    retell_phone: Optional[str] = None
    twilio_phone: Optional[str] = None
    calcom_event_type_id: Optional[str] = None
    calcom_booking_link: Optional[str] = None
    kb_path: Optional[str] = None
    template_path: Optional[str] = None
    timezone: str = "America/New_York"
    is_active: int = 1
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class CallRecord(BaseModel):
    id: str
    client_id: str
    call_id: Optional[str] = None
    caller_phone: Optional[str] = None
    caller_name: Optional[str] = None
    direction: str = "inbound"
    duration: Optional[int] = None
    outcome: Optional[str] = None
    calcom_booking_id: Optional[str] = None
    sentiment: Optional[str] = None
    summary: Optional[str] = None
    score: Optional[int] = None
    transcript: Optional[str] = None
    analysis_data: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class MessageRecord(BaseModel):
    id: str
    client_id: str
    lead_id: Optional[str] = None
    phone: Optional[str] = None
    channel: str = "sms"
    direction: str = "inbound"
    body: Optional[str] = None
    reply_text: Optional[str] = None
    reply_source: str = "claude"
    status: str = "received"
    message_sid: Optional[str] = None
    confidence: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class LeadRecord(BaseModel):
    id: str
    client_id: str
    name: Optional[str] = None
    phone: str
    email: Optional[str] = None
    source: Optional[str] = None
    score: int = 0
    stage: str = "new"
    last_contact: Optional[str] = None
    calcom_booking_id: Optional[str] = None
    notes: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class FollowupRecord(BaseModel):
    id: str
    lead_id: str
    client_id: str
    touch_number: int
    type: Optional[str] = None
    content: Optional[str] = None
    content_source: str = "claude"
    scheduled_at: str
    sent_at: Optional[str] = None
    status: str = "scheduled"
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class ProspectRecord(BaseModel):
    id: str
    business_name: str
    phone: Optional[str] = None
    email: Optional[str] = None
    website: Optional[str] = None
    address: Optional[str] = None
    industry: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    country: str = "US"
    rating: Optional[float] = None
    review_count: Optional[int] = None
    hours: Optional[str] = None
    status: str = "scraped"
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class CampaignRecord(BaseModel):
    id: str
    name: str
    industry: Optional[str] = None
    city: Optional[str] = None
    total_prospects: int = 0
    total_sent: int = 0
    total_replied: int = 0
    total_positive: int = 0
    total_booked: int = 0
    status: str = "draft"
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class EmailRecord(BaseModel):
    id: str
    campaign_id: Optional[str] = None
    prospect_id: Optional[str] = None
    to_email: Optional[str] = None
    from_email: Optional[str] = None
    subject: Optional[str] = None
    body: Optional[str] = None
    sent_at: Optional[str] = None
    status: str = "draft"
    reply_text: Optional[str] = None
    reply_classification: Optional[str] = None
    reply_at: Optional[str] = None
    auto_response_sent: int = 0
    error: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class WeeklyReportRecord(BaseModel):
    id: str
    client_id: str
    week_start: Optional[str] = None
    week_end: Optional[str] = None
    calls_answered: int = 0
    calls_transferred: int = 0
    messages_handled: int = 0
    appointments_booked: int = 0
    estimated_revenue: float = 0
    missed_call_rate: float = 0
    summary_text: Optional[str] = None
    sent_at: Optional[str] = None


# ---------------------------------------------------------------------------
# Tool input models
# ---------------------------------------------------------------------------

class HandleCallInput(BaseModel):
    call_id: str
    caller_phone: str
    duration: int
    outcome: str
    client_id: str
    calcom_booking_id: Optional[str] = None


class TransferCallInput(BaseModel):
    call_id: str
    caller_phone: str
    client_id: str


class OutboundCallInput(BaseModel):
    contact_phone: str
    purpose: str
    client_id: str


class HandleMessageInput(BaseModel):
    message_text: str
    sender_phone: str
    client_id: str
    channel: str = "sms"


class ScheduleFollowupInput(BaseModel):
    lead_id: str
    client_id: str
    trigger_event: str  # 'booking_made' | 'call_completed' | 'message_replied'
    appointment_time: Optional[str] = None
    service: Optional[str] = None


class ScoreLeadInput(BaseModel):
    text: str
    client_id: str
    interaction_type: str


class AnalyzeCallInput(BaseModel):
    retell_call_id: str
    client_id: str


class CheckBookingsInput(BaseModel):
    client_id: str
    start_date: str
    end_date: str


class CancelBookingInput(BaseModel):
    booking_id: str
    reason: str


class GenerateReportInput(BaseModel):
    client_id: str


class ScrapeBusinessesInput(BaseModel):
    industry: str
    city: str
    country: str = "US"
    max_results: int = 50


class WriteColdEmailInput(BaseModel):
    prospect_id: str


class SendCampaignInput(BaseModel):
    campaign_id: str


class ClassifyReplyInput(BaseModel):
    email_id: str
