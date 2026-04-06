const express = require('express');
const router = express.Router();
const { isValidUUID } = require('../../utils/validate');
const { logger } = require('../../utils/logger');

// GET /stats/:clientId
router.get('/stats/:clientId', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    // Validate clientId format
    if (!isValidUUID(clientId)) {
      return res.status(400).json({ error: 'Invalid client ID format' });
    }

    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);

    const startOfLastWeek = new Date(startOfWeek);
    startOfLastWeek.setDate(startOfLastWeek.getDate() - 7);

    const thisWeekStr = startOfWeek.toISOString();
    const lastWeekStr = startOfLastWeek.toISOString();

    // Calls
    const callsThisWeek = db.prepare(
      'SELECT COUNT(*) as count FROM calls WHERE client_id = ? AND created_at >= ?'
    ).get(clientId, thisWeekStr).count;

    const callsLastWeek = db.prepare(
      'SELECT COUNT(*) as count FROM calls WHERE client_id = ? AND created_at >= ? AND created_at < ?'
    ).get(clientId, lastWeekStr, thisWeekStr).count;

    const callsTrend = callsLastWeek > 0
      ? Math.round(((callsThisWeek - callsLastWeek) / callsLastWeek) * 100)
      : callsThisWeek > 0 ? 100 : 0;

    // Messages
    const messagesThisWeek = db.prepare(
      'SELECT COUNT(*) as count FROM messages WHERE client_id = ? AND created_at >= ?'
    ).get(clientId, thisWeekStr).count;

    const messagesLastWeek = db.prepare(
      'SELECT COUNT(*) as count FROM messages WHERE client_id = ? AND created_at >= ? AND created_at < ?'
    ).get(clientId, lastWeekStr, thisWeekStr).count;

    const messagesTrend = messagesLastWeek > 0
      ? Math.round(((messagesThisWeek - messagesLastWeek) / messagesLastWeek) * 100)
      : messagesThisWeek > 0 ? 100 : 0;

    // Bookings
    const bookingsThisWeek = db.prepare(
      "SELECT COUNT(*) as count FROM calls WHERE client_id = ? AND outcome = 'booked' AND created_at >= ?"
    ).get(clientId, thisWeekStr).count;

    // Revenue estimate
    const client = db.prepare('SELECT avg_ticket FROM clients WHERE id = ?').get(clientId);
    const avgTicket = client?.avg_ticket || 0;
    const estimatedRevenue = bookingsThisWeek * avgTicket;

    // Leads by stage — single GROUP BY query instead of N+1
    const stages = ['new', 'contacted', 'qualified', 'booked', 'completed', 'lost'];
    const leadsByStage = {};
    stages.forEach(s => { leadsByStage[s] = 0; });
    const stageRows = db.prepare(
      'SELECT stage, COUNT(*) as count FROM leads WHERE client_id = ? GROUP BY stage'
    ).all(clientId);
    for (const row of stageRows) {
      if (stages.includes(row.stage)) leadsByStage[row.stage] = row.count;
    }

    res.json({
      data: {
        calls_this_week: callsThisWeek,
        calls_last_week: callsLastWeek,
        calls_trend: callsTrend,
        messages_this_week: messagesThisWeek,
        messages_last_week: messagesLastWeek,
        messages_trend: messagesTrend,
        bookings_this_week: bookingsThisWeek,
        estimated_revenue: estimatedRevenue,
        leads_by_stage: leadsByStage
      }
    });
  } catch (err) {
    logger.error('[api] stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

module.exports = router;
