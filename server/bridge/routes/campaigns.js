const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const config = require('../utils/config');
const { logger } = require('../utils/logger');
const { logDataMutation } = require('../utils/auditLog');
const { isAsync } = require('../utils/dbAdapter');
const { validateBody, validateParams } = require('../middleware/validateRequest');
const { CampaignCreateSchema, CampaignParamsSchema } = require('../utils/schemas/campaigns');
const { emailSendLimit } = require('../middleware/rateLimits');
const { AppError } = require('../utils/AppError');

// POST /campaign
router.post('/campaign', validateBody(CampaignCreateSchema), async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { name, industry, city, prospectIds } = req.body;

    const id = randomUUID();
    const now = new Date().toISOString();

    if (isAsync(db)) {
      // Postgres: async transaction
      await db.query('BEGIN', [], 'run');
      try {
        await db.query(`
          INSERT INTO campaigns (id, name, industry, city, client_id, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)
        `, [id, name, industry || null, city || null, req.clientId, now, now], 'run');

        for (const pid of prospectIds) {
          await db.query(
            'INSERT INTO campaign_prospects (id, campaign_id, prospect_id, created_at) VALUES (?, ?, ?, ?)',
            [randomUUID(), id, pid, now], 'run'
          );
        }
        await db.query('COMMIT', [], 'run');
      } catch (txErr) {
        await db.query('ROLLBACK', [], 'run');
        throw txErr;
      }
    } else {
      // SQLite: sync transaction
      const createCampaign = db.transaction((campaignId, campaignName, industryVal, cityVal, clientId, timestamp) => {
        db.prepare(`
          INSERT INTO campaigns (id, name, industry, city, client_id, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)
        `).run(campaignId, campaignName, industryVal, cityVal, clientId, timestamp, timestamp);

        const linkStmt = db.prepare(
          'INSERT INTO campaign_prospects (id, campaign_id, prospect_id, created_at) VALUES (?, ?, ?, ?)'
        );
        for (const pid of prospectIds) {
          linkStmt.run(randomUUID(), campaignId, pid, timestamp);
        }
      });
      createCampaign(id, name, industry || null, city || null, req.clientId, now);
    }

    try { logDataMutation(db, { action: 'client_created', table: 'campaigns', recordId: id, newValues: { name, industry, city, status: 'draft', prospect_count: prospectIds.length } }); } catch (_) {}

    res.status(201).json({ campaign: { id, name, industry, city, status: 'draft', prospect_count: prospectIds.length } });
  } catch (err) {
    logger.error('[outreach] campaign create error:', err);
    res.status(500).json({ error: 'Failed to create campaign' });
  }
});

// POST /campaign/:campaignId/generate
// POST /campaign/:campaignId/generate — 20/min per client (AI call per prospect)
router.post('/campaign/:campaignId/generate', emailSendLimit, validateParams(CampaignParamsSchema), async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { campaignId } = req.params;

    const campaign = await db.query('SELECT * FROM campaigns WHERE id = ?', [campaignId], 'get');
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    if (!req.isAdmin && campaign.client_id !== req.clientId) {
      return next(new AppError('FORBIDDEN', 'Access denied', 403));
    }

    // Get all prospects in campaign
    const prospects = await db.query(`
      SELECT p.* FROM prospects p
      JOIN campaign_prospects cp ON cp.prospect_id = p.id
      WHERE cp.campaign_id = ?
    `, [campaignId], 'all');

    if (!prospects.length) {
      return res.status(400).json({ error: 'No prospects in campaign' });
    }

    const { generateColdEmail, pickVariant } = require('../utils/emailGenerator');
    const emails = [];
    const senderEmail = process.env.SMTP_FROM || process.env.SMTP_USER;

    for (let idx = 0; idx < prospects.length; idx++) {
      const prospect = prospects[idx];
      if (!prospect.email) continue;

      // Skip bounced/unsubscribed prospects
      if (['bounced', 'unsubscribed'].includes(prospect.status)) continue;

      try {
        const emailGen = await generateColdEmail(prospect);
        const variant = pickVariant(idx);
        const subject = variant === 'A' ? emailGen.subject_a : emailGen.subject_b;

        const emailId = randomUUID();
        const now = new Date().toISOString();

        await db.query(`
          INSERT INTO emails_sent (id, campaign_id, prospect_id, to_email, from_email, subject, body, subject_a, subject_b, variant, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
        `, [emailId, campaignId, prospect.id, prospect.email, senderEmail, subject, emailGen.body, emailGen.subject_a, emailGen.subject_b, variant, now, now], 'run');

        emails.push({ id: emailId, prospect_id: prospect.id, to_email: prospect.email, subject, body: emailGen.body, variant, status: 'draft' });
      } catch (err) {
        logger.error(`[outreach] Failed to generate email for ${prospect.business_name}:`, err.message);
      }
    }

    res.json({ generated: emails.length, emails });
  } catch (err) {
    logger.error('[outreach] generate error:', err);
    res.status(500).json({ error: 'Failed to generate emails' });
  }
});

// GET /campaign/:campaignId/ab-results
router.get('/campaign/:campaignId/ab-results', validateParams(CampaignParamsSchema), async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { campaignId } = req.params;

    const campaign = await db.query('SELECT * FROM campaigns WHERE id = ?', [campaignId], 'get');
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    if (!req.isAdmin && campaign.client_id !== req.clientId) {
      return next(new AppError('FORBIDDEN', 'Access denied', 403));
    }

    // Get all emails in campaign grouped by variant
    const clientFilter = req.isAdmin ? '' : 'AND client_id = ?';
    const clientParams = req.isAdmin ? [] : [req.clientId];

    const variantA = await db.query(`
      SELECT
        COUNT(*) as sent,
        SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) as opened,
        SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END) as clicked
      FROM emails_sent
      WHERE campaign_id = ? AND status IN ('sent', 'bounced', 'failed') AND variant = 'A' ${clientFilter}
    `, [campaignId, ...clientParams], 'get');

    const variantB = await db.query(`
      SELECT
        COUNT(*) as sent,
        SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) as opened,
        SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END) as clicked
      FROM emails_sent
      WHERE campaign_id = ? AND status IN ('sent', 'bounced', 'failed') AND variant = 'B' ${clientFilter}
    `, [campaignId, ...clientParams], 'get');

    // Get top subject line for each variant
    const topSubjectA = await db.query(`
      SELECT subject, COUNT(*) as count FROM emails_sent
      WHERE campaign_id = ? AND variant = 'A' ${clientFilter}
      GROUP BY subject
      ORDER BY count DESC
      LIMIT 1
    `, [campaignId, ...clientParams], 'get');

    const topSubjectB = await db.query(`
      SELECT subject, COUNT(*) as count FROM emails_sent
      WHERE campaign_id = ? AND variant = 'B' ${clientFilter}
      GROUP BY subject
      ORDER BY count DESC
      LIMIT 1
    `, [campaignId, ...clientParams], 'get');

    // Calculate rates
    const aOpenRate = variantA.sent > 0 ? variantA.opened / variantA.sent : 0;
    const aClickRate = variantA.sent > 0 ? variantA.clicked / variantA.sent : 0;
    const bOpenRate = variantB.sent > 0 ? variantB.opened / variantB.sent : 0;
    const bClickRate = variantB.sent > 0 ? variantB.clicked / variantB.sent : 0;

    // Determine winner (highest open rate)
    const winner = aOpenRate >= bOpenRate ? 'A' : 'B';

    res.json({
      variant_a: {
        sent: variantA.sent || 0,
        opened: variantA.opened || 0,
        clicked: variantA.clicked || 0,
        open_rate: Math.round(aOpenRate * 100) / 100,
        click_rate: Math.round(aClickRate * 100) / 100,
        top_subject: topSubjectA?.subject || 'N/A'
      },
      variant_b: {
        sent: variantB.sent || 0,
        opened: variantB.opened || 0,
        clicked: variantB.clicked || 0,
        open_rate: Math.round(bOpenRate * 100) / 100,
        click_rate: Math.round(bClickRate * 100) / 100,
        top_subject: topSubjectB?.subject || 'N/A'
      },
      winner
    });
  } catch (err) {
    logger.error('[outreach] ab-results error:', err);
    res.status(500).json({ error: 'Failed to get A/B results' });
  }
});

module.exports = router;
