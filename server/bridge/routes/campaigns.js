const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const config = require('../utils/config');
const { logger } = require('../utils/logger');

// POST /campaign
router.post('/campaign', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { name, industry, city, prospectIds } = req.body;

    if (!name || !prospectIds?.length) {
      return res.status(400).json({ error: 'name and prospectIds are required' });
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    // Wrap campaign creation in transaction to ensure all-or-nothing semantics
    const createCampaign = db.transaction((campaignId, campaignName, industryVal, cityVal, timestamp) => {
      // Insert campaign
      db.prepare(`
        INSERT INTO campaigns (id, name, industry, city, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'draft', ?, ?)
      `).run(campaignId, campaignName, industryVal, cityVal, timestamp, timestamp);

      // Link prospects to campaign
      const linkStmt = db.prepare(
        'INSERT INTO campaign_prospects (id, campaign_id, prospect_id, created_at) VALUES (?, ?, ?, ?)'
      );
      for (const pid of prospectIds) {
        linkStmt.run(randomUUID(), campaignId, pid, timestamp);
      }
    });

    createCampaign(id, name, industry || null, city || null, now);

    res.status(201).json({ campaign: { id, name, industry, city, status: 'draft', prospect_count: prospectIds.length } });
  } catch (err) {
    logger.error('[outreach] campaign create error:', err);
    res.status(500).json({ error: 'Failed to create campaign' });
  }
});

// POST /campaign/:campaignId/generate
router.post('/campaign/:campaignId/generate', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { campaignId } = req.params;

    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    // Get all prospects in campaign
    const prospects = db.prepare(`
      SELECT p.* FROM prospects p
      JOIN campaign_prospects cp ON cp.prospect_id = p.id
      WHERE cp.campaign_id = ?
    `).all(campaignId);

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

        db.prepare(`
          INSERT INTO emails_sent (id, campaign_id, prospect_id, to_email, from_email, subject, body, subject_a, subject_b, variant, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
        `).run(emailId, campaignId, prospect.id, prospect.email, senderEmail, subject, emailGen.body, emailGen.subject_a, emailGen.subject_b, variant, now, now);

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
router.get('/campaign/:campaignId/ab-results', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { campaignId } = req.params;

    // Get all emails in campaign grouped by variant
    const variantA = db.prepare(`
      SELECT
        COUNT(*) as sent,
        SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) as opened,
        SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END) as clicked
      FROM emails_sent
      WHERE campaign_id = ? AND status IN ('sent', 'bounced', 'failed') AND variant = 'A'
    `).get(campaignId);

    const variantB = db.prepare(`
      SELECT
        COUNT(*) as sent,
        SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) as opened,
        SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END) as clicked
      FROM emails_sent
      WHERE campaign_id = ? AND status IN ('sent', 'bounced', 'failed') AND variant = 'B'
    `).get(campaignId);

    // Get top subject line for each variant
    const topSubjectA = db.prepare(`
      SELECT subject, COUNT(*) as count FROM emails_sent
      WHERE campaign_id = ? AND variant = 'A'
      GROUP BY subject
      ORDER BY count DESC
      LIMIT 1
    `).get(campaignId);

    const topSubjectB = db.prepare(`
      SELECT subject, COUNT(*) as count FROM emails_sent
      WHERE campaign_id = ? AND variant = 'B'
      GROUP BY subject
      ORDER BY count DESC
      LIMIT 1
    `).get(campaignId);

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
