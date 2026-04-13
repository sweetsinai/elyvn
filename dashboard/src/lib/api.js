import { buildQueryString } from './utils';

const API_BASE = '/api';

/**
 * Get API key from session storage. All authenticated requests use this.
 */
function getHeaders(extra = {}) {
  const token = sessionStorage.getItem('elyvn_token');
  const apiKey = sessionStorage.getItem('elyvn_api_key');
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(apiKey ? { 'x-api-key': apiKey } : {}),
    ...extra,
  };
}

function jsonHeaders() {
  return getHeaders({ 'Content-Type': 'application/json' });
}

/**
 * Wrapper for fetch that auto-injects auth header and handles errors.
 */
export async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { ...getHeaders(), ...(options.headers || {}) },
  });
  if (res.status === 401) {
    // Auth expired or invalid — clear and reload
    sessionStorage.removeItem('elyvn_api_key');
    window.location.reload();
    throw new Error('Unauthorized');
  }
  // Check if response is JSON before parsing
  const contentType = res.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    const json = await res.json();
    // Unwrap success()/paginated() envelope: { success, data, pagination, timestamp } → data
    if (json && json.success === true && json.data !== undefined) {
      const result = json.data;
      // Attach pagination metadata if present (accessible via result._pagination)
      if (json.pagination && result && typeof result === 'object') {
        Object.defineProperty(result, '_pagination', { value: json.pagination, enumerable: false });
      }
      return result;
    }
    return json;
  } else {
    // Non-JSON response
    throw new Error(`Expected JSON response, got ${contentType || 'unknown'}`);
  }
}

// Health (no auth needed)
export const getHealth = () =>
  fetch('/health').then(r => r.json());

// Stats
export const getStats = (clientId) =>
  apiFetch(`${API_BASE}/stats/${clientId}`);

// Calls
export const getCalls = (clientId, params = {}) =>
  apiFetch(`${API_BASE}/calls/${clientId}${buildQueryString(params)}`);

export const getTranscript = (clientId, callId) =>
  apiFetch(`${API_BASE}/calls/${clientId}/${callId}/transcript`);

// Messages
export const getMessages = (clientId, params = {}) =>
  apiFetch(`${API_BASE}/messages/${clientId}${buildQueryString(params)}`);

// Leads
export const getLeads = (clientId, params = {}) =>
  apiFetch(`${API_BASE}/leads/${clientId}${buildQueryString(params)}`);

export const updateLeadStage = (clientId, leadId, stage) =>
  apiFetch(`${API_BASE}/leads/${clientId}/${leadId}`, {
    method: 'PUT',
    headers: jsonHeaders(),
    body: JSON.stringify({ stage }),
  });

// Bookings
export const getBookings = (clientId, startDate, endDate) =>
  apiFetch(`${API_BASE}/bookings/${clientId}${buildQueryString({ startDate, endDate })}`);

// Outreach
export const scrapeBusinesses = (data) =>
  apiFetch(`${API_BASE}/outreach/scrape`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(data),
  });

export const getCampaigns = () =>
  apiFetch(`${API_BASE}/outreach/campaign`);

export const createCampaign = (data) =>
  apiFetch(`${API_BASE}/outreach/campaign`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(data),
  });

export const generateEmails = (campaignId) =>
  apiFetch(`${API_BASE}/outreach/campaign/${campaignId}/generate`, {
    method: 'POST',
  });

export const sendCampaign = (campaignId) =>
  apiFetch(`${API_BASE}/outreach/campaign/${campaignId}/send`, {
    method: 'POST',
  });

export const getReplies = () =>
  apiFetch(`${API_BASE}/outreach/replies`);

export const classifyReply = (emailId) =>
  apiFetch(`${API_BASE}/outreach/replies/${emailId}/classify`, {
    method: 'POST',
  });

// Clients
export const getClients = () =>
  apiFetch(`${API_BASE}/clients`);

export const createClient = (data) =>
  apiFetch(`${API_BASE}/clients`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(data),
  });

export const updateClient = (clientId, data) =>
  apiFetch(`${API_BASE}/clients/${clientId}`, {
    method: 'PUT',
    headers: jsonHeaders(),
    body: JSON.stringify(data),
  });

// Intelligence
export const getIntelligence = (clientId, days = 30) =>
  apiFetch(`${API_BASE}/intelligence/${clientId}?days=${days}`);

export const getPeakHours = (clientId) =>
  apiFetch(`${API_BASE}/intelligence/${clientId}/peak-hours`);

export const getResponseImpact = (clientId) =>
  apiFetch(`${API_BASE}/intelligence/${clientId}/response-impact`);

// Scoring
export const getLeadScores = (clientId) =>
  apiFetch(`${API_BASE}/scoring/${clientId}`);

export const getConversionAnalytics = (clientId) =>
  apiFetch(`${API_BASE}/scoring/${clientId}/analytics/conversion`);

// Revenue
export const getRevenue = (clientId, days = 30) =>
  apiFetch(`${API_BASE}/revenue/${clientId}?days=${days}`);

export const getChannelPerformance = (clientId) =>
  apiFetch(`${API_BASE}/revenue/${clientId}/channels/performance`);

// Schedule
export const getDailySchedule = (clientId) =>
  apiFetch(`${API_BASE}/schedule/${clientId}`);

// Provision
export const provisionClient = (data) =>
  apiFetch(`${API_BASE}/provision`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(data),
  });

// Transfer
export const transferCall = (clientId, callId, transferPhone) =>
  apiFetch(`${API_BASE}/calls/${clientId}/${callId}/transfer`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(transferPhone ? { transfer_phone: transferPhone } : {}),
  });

// Integrations
export const getWebhookLog = (clientId) =>
  apiFetch(`${API_BASE}/integrations/${clientId}/webhook-log`);

export const testWebhook = (clientId, eventType) =>
  apiFetch(`${API_BASE}/integrations/${clientId}/webhook-test`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ event_type: eventType }),
  });

export const getIntegrationStatus = (clientId) =>
  apiFetch(`${API_BASE}/integrations/${clientId}/status`);

// Conversations (Phase 5 — unified messaging)
export const getConversations = (clientId, params = {}) =>
  apiFetch(`${API_BASE}/conversations/${clientId}${buildQueryString(params)}`);

export const getConversationTimeline = (clientId, conversationId, params = {}) =>
  apiFetch(`${API_BASE}/conversations/${clientId}/${conversationId}/timeline${buildQueryString(params)}`);

export const sendConversationMessage = (clientId, conversationId, body) =>
  apiFetch(`${API_BASE}/conversations/${clientId}/${conversationId}/send`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ body }),
  });

export const markConversationRead = (clientId, conversationId) =>
  apiFetch(`${API_BASE}/conversations/${clientId}/${conversationId}/read`, {
    method: 'PUT',
    headers: jsonHeaders(),
    body: JSON.stringify({}),
  });

export const archiveConversation = (clientId, conversationId) =>
  apiFetch(`${API_BASE}/conversations/${clientId}/${conversationId}/archive`, {
    method: 'PUT',
    headers: jsonHeaders(),
    body: JSON.stringify({}),
  });

// Settings
export const getSettings = (clientId) =>
  apiFetch(`${API_BASE}/settings/${clientId}`);

export const updateSettings = (clientId, data) =>
  apiFetch(`${API_BASE}/settings/${clientId}`, {
    method: 'PUT',
    headers: jsonHeaders(),
    body: JSON.stringify(data),
  });
