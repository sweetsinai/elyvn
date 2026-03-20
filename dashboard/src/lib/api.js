import { buildQueryString } from './utils';

const API_BASE = '/api';

// Health
export const getHealth = () =>
  fetch('/health').then(r => r.json());

// Stats
export const getStats = (clientId) =>
  fetch(`${API_BASE}/stats/${clientId}`).then(r => r.json());

// Calls
export const getCalls = (clientId, params = {}) =>
  fetch(`${API_BASE}/calls/${clientId}${buildQueryString(params)}`).then(r => r.json());

export const getTranscript = (clientId, callId) =>
  fetch(`${API_BASE}/calls/${clientId}/${callId}/transcript`).then(r => r.json());

// Messages
export const getMessages = (clientId, params = {}) =>
  fetch(`${API_BASE}/messages/${clientId}${buildQueryString(params)}`).then(r => r.json());

// Leads
export const getLeads = (clientId, params = {}) =>
  fetch(`${API_BASE}/leads/${clientId}${buildQueryString(params)}`).then(r => r.json());

export const updateLeadStage = (clientId, leadId, stage) =>
  fetch(`${API_BASE}/leads/${clientId}/${leadId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage }),
  }).then(r => r.json());

// Bookings
export const getBookings = (clientId, startDate, endDate) =>
  fetch(`${API_BASE}/bookings/${clientId}${buildQueryString({ startDate, endDate })}`).then(r => r.json());

// Outreach
export const scrapeBusinesses = (data) =>
  fetch(`${API_BASE}/outreach/scrape`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then(r => r.json());

export const getCampaigns = () =>
  fetch(`${API_BASE}/outreach/campaign`).then(r => r.json());

export const createCampaign = (data) =>
  fetch(`${API_BASE}/outreach/campaign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then(r => r.json());

export const generateEmails = (campaignId) =>
  fetch(`${API_BASE}/outreach/campaign/${campaignId}/generate`, {
    method: 'POST',
  }).then(r => r.json());

export const sendCampaign = (campaignId) =>
  fetch(`${API_BASE}/outreach/campaign/${campaignId}/send`, {
    method: 'POST',
  }).then(r => r.json());

export const getReplies = () =>
  fetch(`${API_BASE}/outreach/replies`).then(r => r.json());

export const classifyReply = (emailId) =>
  fetch(`${API_BASE}/outreach/replies/${emailId}/classify`, {
    method: 'POST',
  }).then(r => r.json());

// Clients
export const getClients = () =>
  fetch(`${API_BASE}/clients`).then(r => r.json());

export const createClient = (data) =>
  fetch(`${API_BASE}/clients`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then(r => r.json());

export const updateClient = (clientId, data) =>
  fetch(`${API_BASE}/clients/${clientId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then(r => r.json());
