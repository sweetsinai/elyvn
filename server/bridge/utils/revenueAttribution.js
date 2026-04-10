/**
 * Revenue Attribution Engine
 * Tracks the full journey from first touch to booking with multi-touch attribution
 */

/**
 * Track the full attribution chain for a booking
 * @param {object} db
 * @param {string} leadId
 * @param {string} clientId
 * @returns {{ first_touch, last_touch, touches: Array, channel_attribution: object, time_to_convert_hours, estimated_value }}
 */
async function getAttribution(db, leadId, clientId) {
  if (!leadId || !clientId) {
    return null;
  }

  // Get lead info
  const lead = await db.query(
    'SELECT * FROM leads WHERE id = ? AND client_id = ?',
    [leadId, clientId], 'get'
  );

  if (!lead) {
    return null;
  }

  // Get all calls for this lead
  const calls = await db.query(
    `SELECT id, caller_phone, direction, outcome, created_at, score, duration
     FROM calls WHERE caller_phone = ? AND client_id = ? ORDER BY created_at ASC`,
    [lead.phone, clientId]
  );

  // Get all messages for this lead
  const messages = await db.query(
    `SELECT id, channel, direction, created_at, status
     FROM messages WHERE phone = ? AND client_id = ? ORDER BY created_at ASC`,
    [lead.phone, clientId]
  );

  // Get all follow-ups for this lead
  const followups = await db.query(
    `SELECT id, type, created_at, sent_at
     FROM followups WHERE lead_id = ? ORDER BY created_at ASC`,
    [leadId]
  );

  // Build timeline of touches
  const touches = [
    ...calls.map(c => ({
      id: c.id,
      type: 'call',
      channel: 'voice',
      timestamp: c.created_at,
      outcome: c.outcome,
      score: c.score,
    })),
    ...messages.map(m => ({
      id: m.id,
      type: 'message',
      channel: m.channel || 'sms',
      timestamp: m.created_at,
      status: m.status,
    })),
    ...followups.map(f => ({
      id: f.id,
      type: 'followup',
      channel: f.type || 'sms',
      timestamp: f.sent_at || f.created_at,
    })),
  ].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  if (touches.length === 0) {
    return {
      first_touch: null,
      last_touch: null,
      touches: [],
      channel_attribution: {},
      time_to_convert_hours: null,
      estimated_value: 0,
    };
  }

  // Determine first and last touch
  const first_touch = touches[0];
  const last_touch = touches[touches.length - 1];

  // Calculate time to convert
  const createdAt = new Date(lead.created_at);
  let time_to_convert_hours = null;
  if (lead.stage === 'booked' && lead.updated_at) {
    const bookedAt = new Date(lead.updated_at);
    time_to_convert_hours = Math.round((bookedAt - createdAt) / (1000 * 60 * 60));
  }

  // Multi-touch attribution: distribute credit across channels
  const channelCounts = {};
  const channelBudget = {};

  for (const touch of touches) {
    const channel = touch.channel;
    if (!channelCounts[channel]) {
      channelCounts[channel] = 0;
      channelBudget[channel] = 0;
    }
    channelCounts[channel]++;
  }

  // Linear attribution (equal credit to all touches)
  const channel_attribution = {};
  for (const channel in channelCounts) {
    channel_attribution[channel] = {
      touches: channelCounts[channel],
      weight: 1 / Object.keys(channelCounts).length,
      attributed_credit: 1 / Object.keys(channelCounts).length,
    };
  }

  // Get estimated value
  const client = await db.query('SELECT avg_ticket FROM clients WHERE id = ?', [clientId], 'get');
  const estimated_value = lead.stage === 'booked' ? (client?.avg_ticket || 0) : 0;

  return {
    first_touch,
    last_touch,
    touches,
    channel_attribution,
    time_to_convert_hours,
    estimated_value,
  };
}

/**
 * Get ROI metrics for a client
 * @param {object} db
 * @param {string} clientId
 * @param {number} [days=30]
 * @returns {{ total_revenue, cost_per_lead, cost_per_booking, roi_multiplier, channel_roi: { sms: {spent, revenue, roi}, voice: {...}, email: {...} }, avg_time_to_close }}
 */
async function getROIMetrics(db, clientId, days = 30) {
  if (!clientId) {
    return null;
  }

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // Get client info
  const client = await db.query('SELECT avg_ticket, phone_number FROM clients WHERE id = ?', [clientId], 'get');
  if (!client) {
    return null;
  }

  const avgTicket = client.avg_ticket || 0;

  // Count total leads and bookings in period
  const leadStats = await db.query(
    `SELECT COUNT(*) as total_leads FROM leads WHERE client_id = ? AND created_at >= ?`,
    [clientId, since], 'get'
  );

  const bookingStats = await db.query(
    `SELECT COUNT(*) as total_bookings FROM calls WHERE client_id = ? AND outcome = 'booked' AND created_at >= ?`,
    [clientId, since], 'get'
  );

  const totalLeads = leadStats?.total_leads || 0;
  const totalBookings = bookingStats?.total_bookings || 0;

  // Calculate revenue from bookings
  const total_revenue = totalBookings * avgTicket;

  // Estimate costs (this is a simplified model)
  // Twilio SMS: ~$0.0075 per message
  // Voice: ~$0.09 per minute
  const smsCount = await db.query(
    `SELECT COUNT(*) as count FROM messages WHERE client_id = ? AND channel = 'sms' AND created_at >= ?`,
    [clientId, since], 'get'
  );
  const smsCost = (smsCount?.count || 0) * 0.0075;

  const callMinutes = await db.query(
    `SELECT SUM(duration) as total_duration FROM calls WHERE client_id = ? AND created_at >= ?`,
    [clientId, since], 'get'
  );
  const voiceCost = ((callMinutes?.total_duration || 0) / 60) * 0.09;

  const emailCount = await db.query(
    `SELECT COUNT(*) as count FROM messages WHERE client_id = ? AND channel = 'email' AND created_at >= ?`,
    [clientId, since], 'get'
  );
  const emailCost = (emailCount?.count || 0) * 0.001; // ~$0.001 per email

  const totalCost = smsCost + voiceCost + emailCost;

  // Calculate derived metrics
  const cost_per_lead = totalLeads > 0 ? totalCost / totalLeads : 0;
  const cost_per_booking = totalBookings > 0 ? totalCost / totalBookings : 0;
  const roi_multiplier = totalCost > 0 ? total_revenue / totalCost : 0;

  // Channel-specific ROI
  const channel_roi = {
    sms: {
      spent: smsCost,
      revenue: (smsCount?.count || 0) > 0 ? (total_revenue * 0.4) : 0, // Estimate 40% of revenue from SMS
      roi: smsCost > 0 ? ((total_revenue * 0.4) / smsCost) : 0,
    },
    voice: {
      spent: voiceCost,
      revenue: (callMinutes?.total_duration || 0) > 0 ? (total_revenue * 0.5) : 0, // Estimate 50% from voice
      roi: voiceCost > 0 ? ((total_revenue * 0.5) / voiceCost) : 0,
    },
    email: {
      spent: emailCost,
      revenue: (emailCount?.count || 0) > 0 ? (total_revenue * 0.1) : 0, // Estimate 10% from email
      roi: emailCost > 0 ? ((total_revenue * 0.1) / emailCost) : 0,
    },
  };

  // Calculate average time to close
  const closedLeads = await db.query(
    `SELECT id, created_at, updated_at FROM leads
     WHERE client_id = ? AND stage IN ('booked', 'completed') AND created_at >= ?`,
    [clientId, since]
  );

  let avg_time_to_close = 0;
  if (closedLeads.length > 0) {
    const totalHours = closedLeads.reduce((sum, lead) => {
      const created = new Date(lead.created_at);
      const updated = new Date(lead.updated_at);
      return sum + (updated - created) / (1000 * 60 * 60);
    }, 0);
    avg_time_to_close = Math.round(totalHours / closedLeads.length);
  }

  return {
    total_revenue: Math.round(total_revenue * 100) / 100,
    cost_per_lead: Math.round(cost_per_lead * 100) / 100,
    cost_per_booking: Math.round(cost_per_booking * 100) / 100,
    roi_multiplier: Math.round(roi_multiplier * 100) / 100,
    channel_roi: {
      sms: {
        spent: Math.round(channel_roi.sms.spent * 100) / 100,
        revenue: Math.round(channel_roi.sms.revenue * 100) / 100,
        roi: Math.round(channel_roi.sms.roi * 100) / 100,
      },
      voice: {
        spent: Math.round(channel_roi.voice.spent * 100) / 100,
        revenue: Math.round(channel_roi.voice.revenue * 100) / 100,
        roi: Math.round(channel_roi.voice.roi * 100) / 100,
      },
      email: {
        spent: Math.round(channel_roi.email.spent * 100) / 100,
        revenue: Math.round(channel_roi.email.revenue * 100) / 100,
        roi: Math.round(channel_roi.email.roi * 100) / 100,
      },
    },
    avg_time_to_close,
    period_days: days,
    total_leads: totalLeads,
    total_bookings: totalBookings,
  };
}

/**
 * Get channel performance breakdown
 * @param {object} db
 * @param {string} clientId
 * @returns {{ channels: Array<{name, leads, bookings, conversion_rate, avg_touches}> }}
 */
async function getChannelPerformance(db, clientId) {
  if (!clientId) {
    return null;
  }

  // Batch query: SMS touch counts per phone for this client
  const smsRows = await db.query(
    `SELECT phone, COUNT(*) AS count FROM messages
     WHERE client_id = ? AND channel = 'sms'
     GROUP BY phone`,
    [clientId]
  );
  const smsByPhone = Object.fromEntries(smsRows.map(r => [r.phone, r.count]));

  // Batch query: voice (call) touch counts per caller_phone for this client
  const voiceRows = await db.query(
    `SELECT caller_phone AS phone, COUNT(*) AS count FROM calls
     WHERE client_id = ?
     GROUP BY caller_phone`,
    [clientId]
  );
  const voiceByPhone = Object.fromEntries(voiceRows.map(r => [r.phone, r.count]));

  // Batch query: email touch counts per phone for this client
  const emailRows = await db.query(
    `SELECT phone, COUNT(*) AS count FROM messages
     WHERE client_id = ? AND channel = 'email'
     GROUP BY phone`,
    [clientId]
  );
  const emailByPhone = Object.fromEntries(emailRows.map(r => [r.phone, r.count]));

  // Get all leads in a single query
  const leads = await db.query(
    'SELECT id, phone, stage FROM leads WHERE client_id = ?',
    [clientId]
  );

  const channelMetrics = {
    sms: { leads: 0, bookings: 0, touches: 0 },
    voice: { leads: 0, bookings: 0, touches: 0 },
    email: { leads: 0, bookings: 0, touches: 0 },
  };

  // Determine primary channel per lead using the pre-fetched maps (no DB calls in loop)
  for (const lead of leads) {
    const touches = {
      sms: smsByPhone[lead.phone] || 0,
      voice: voiceByPhone[lead.phone] || 0,
      email: emailByPhone[lead.phone] || 0,
    };

    const primaryChannel = Object.entries(touches).reduce((a, b) => b[1] > a[1] ? b : a)[0];

    if (primaryChannel) {
      channelMetrics[primaryChannel].leads++;
      channelMetrics[primaryChannel].touches += touches[primaryChannel];
      if (lead.stage === 'booked') {
        channelMetrics[primaryChannel].bookings++;
      }
    }
  }

  // Calculate conversion rates and averages
  const channels = Object.entries(channelMetrics).map(([name, metrics]) => ({
    name,
    leads: metrics.leads,
    bookings: metrics.bookings,
    conversion_rate: metrics.leads > 0 ? Math.round((metrics.bookings / metrics.leads) * 10000) / 100 : 0,
    avg_touches: metrics.leads > 0 ? Math.round((metrics.touches / metrics.leads) * 100) / 100 : 0,
  }));

  return { channels };
}

module.exports = {
  getAttribution,
  getROIMetrics,
  getChannelPerformance,
};
