import { buildQueryString } from './utils';

const API_BASE = '/api';

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

export async function apiFetch(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(url, {
      ...options,
      credentials: 'include',
      signal: controller.signal,
      headers: { ...getHeaders(), ...(options.headers || {}) },
    });
    clearTimeout(timeoutId);

    if (res.status === 401) {
      sessionStorage.removeItem('elyvn_api_key');
      sessionStorage.removeItem('elyvn_token');
      window.location.reload();
      throw new Error('Unauthorized');
    }

    const contentType = res.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const json = await res.json();
      if (json && json.success === true && json.data !== undefined) {
        const result = json.data;
        if (json.pagination && result && typeof result === 'object') {
          Object.defineProperty(result, '_pagination', { value: json.pagination, enumerable: false });
        }
        return result;
      }
      return json;
    } else {
      throw new Error(`Expected JSON response, got ${contentType || 'unknown'}`);
    }
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error('Request timeout — please try again');
    }
    throw err;
  }
}

export const getHealth = () => fetch('/health').then(r => r.json());
export const getStats = (clientId) => apiFetch(`${API_BASE}/stats/${clientId}`);
export const getCalls = (clientId, params = {}) => apiFetch(`${API_BASE}/calls/${clientId}${buildQueryString(params)}`);
export const getTranscript = (clientId, callId) => apiFetch(`${API_BASE}/calls/${clientId}/${callId}/transcript`);
export const getMessages = (clientId, params = {}) => apiFetch(`${API_BASE}/messages/${clientId}${buildQueryString(params)}`);
export const getLeads = (clientId, params = {}) => apiFetch(`${API_BASE}/leads/${clientId}${buildQueryString(params)}`);
export const updateLeadStage = (clientId, leadId, stage) => apiFetch(`${API_BASE}/leads/${clientId}/${leadId}`, { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ stage }) });
export const getBookings = (clientId, startDate, endDate) => apiFetch(`${API_BASE}/bookings/${clientId}${buildQueryString({ startDate, endDate })}`);
export const scrapeBusinesses = (data) => apiFetch(`${API_BASE}/outreach/scrape`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(data) });
export const getCampaigns = () => apiFetch(`${API_BASE}/outreach/campaign`);
export const createCampaign = (data) => apiFetch(`${API_BASE}/outreach/campaign`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(data) });
export const generateEmails = (campaignId) => apiFetch(`${API_BASE}/outreach/campaign/${campaignId}/generate`, { method: 'POST' });
export const sendCampaign = (campaignId) => apiFetch(`${API_BASE}/outreach/campaign/${campaignId}/send`, { method: 'POST' });
export const getReplies = () => apiFetch(`${API_BASE}/outreach/replies`);
export const classifyReply = (emailId) => apiFetch(`${API_BASE}/outreach/replies/${emailId}/classify`, { method: 'POST' });
export const getClients = () => apiFetch(`${API_BASE}/clients`);
export const createClient = (data) => apiFetch(`${API_BASE}/clients`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(data) });
export const updateClient = (clientId, data) => apiFetch(`${API_BASE}/clients/${clientId}`, { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify(data) });
export const getIntelligence = (clientId, days = 30) => apiFetch(`${API_BASE}/intelligence/${clientId}?days=${days}`);
export const getPeakHours = (clientId) => apiFetch(`${API_BASE}/intelligence/${clientId}/peak-hours`);
export const getResponseImpact = (clientId) => apiFetch(`${API_BASE}/intelligence/${clientId}/response-impact`);
export const getLeadScores = (clientId) => apiFetch(`${API_BASE}/scoring/${clientId}`);
export const getConversionAnalytics = (clientId) => apiFetch(`${API_BASE}/scoring/${clientId}/analytics/conversion`);
export const getRevenue = (clientId, days = 30) => apiFetch(`${API_BASE}/revenue/${clientId}?days=${days}`);
export const getChannelPerformance = (clientId) => apiFetch(`${API_BASE}/revenue/${clientId}/channels/performance`);
export const getDailySchedule = (clientId) => apiFetch(`${API_BASE}/schedule/${clientId}`);
export const provisionClient = (data) => apiFetch(`${API_BASE}/provision`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(data) });
export const transferCall = (clientId, callId, transferPhone) => apiFetch(`${API_BASE}/calls/${clientId}/${callId}/transfer`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(transferPhone ? { transfer_phone: transferPhone } : {}) });
export const getWebhookLog = (clientId) => apiFetch(`${API_BASE}/integrations/${clientId}/webhook-log`);
export const testWebhook = (clientId, eventType) => apiFetch(`${API_BASE}/integrations/${clientId}/webhook-test`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ event_type: eventType }) });
export const getIntegrationStatus = (clientId) => apiFetch(`${API_BASE}/integrations/${clientId}/status`);
export const getConversations = (clientId, params = {}) => apiFetch(`${API_BASE}/conversations/${clientId}${buildQueryString(params)}`);
export const getConversationTimeline = (clientId, conversationId, params = {}) => apiFetch(`${API_BASE}/conversations/${clientId}/${conversationId}/timeline${buildQueryString(params)}`);
export const sendConversationMessage = (clientId, conversationId, body) => apiFetch(`${API_BASE}/conversations/${clientId}/${conversationId}/send`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ body }) });
export const markConversationRead = (clientId, conversationId) => apiFetch(`${API_BASE}/conversations/${clientId}/${conversationId}/read`, { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({}) });
export const archiveConversation = (clientId, conversationId) => apiFetch(`${API_BASE}/conversations/${clientId}/${conversationId}/archive`, { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({}) });
export const getSettings = (clientId) => apiFetch(`${API_BASE}/settings/${clientId}`);
export const updateSettings = (clientId, data) => apiFetch(`${API_BASE}/settings/${clientId}`, { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify(data) });
