/**
 * Client Settings API
 * Grouped settings endpoints for the client portal.
 */
const express = require('express');
const router = express.Router();
const { isValidUUID } = require('../../utils/validate');
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/AppError');
const { logDataMutation } = require('../../utils/auditLog');
const { success } = require('../../utils/response');
const { validateBody } = require('../../middleware/validateRequest');
const { SettingsUpdateSchema } = require('../../utils/schemas/settings');
const { clientIsolationParam } = require('../../utils/clientIsolation');
const { syncClientToRetell } = require('../../utils/retellSync');
router.param('clientId', clientIsolationParam);

// GET /settings/:clientId — All client settings grouped by category
router.get('/settings/:clientId', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;
    if (!isValidUUID(clientId)) return next(new AppError('INVALID_INPUT', 'Invalid client ID', 400));

    const client = await db.query(`
      SELECT business_name, owner_name, owner_email, owner_phone, industry, timezone,
             twilio_phone, retell_agent_id, retell_phone, retell_voice, retell_language,
             transfer_phone, whatsapp_phone, phone_number,
             calcom_booking_link, calcom_event_type_id, google_review_link,
             telegram_chat_id, notification_mode,
             plan, subscription_status, avg_ticket,
             is_active, auto_followup_enabled,
             facebook_page_id, instagram_user_id,
             onboarding_step, onboarding_completed,
             referral_code,
             lead_webhook_url, booking_webhook_url, call_webhook_url,
             sms_webhook_url, stage_change_webhook_url
      FROM clients WHERE id = ?
    `, [clientId], 'get');

    if (!client) return next(new AppError('NOT_FOUND', 'Client not found', 404));

    success(res, {
      business: {
        business_name: client.business_name,
        owner_name: client.owner_name,
        owner_email: client.owner_email,
        owner_phone: client.owner_phone,
        industry: client.industry,
        timezone: client.timezone,
        avg_ticket: client.avg_ticket,
      },
      phone: {
        phone_number: client.phone_number,
      },
      voice: {
        retell_agent_id: client.retell_agent_id,
        retell_phone: client.retell_phone,
        retell_voice: client.retell_voice || '11labs-Adrian',
        retell_language: client.retell_language || 'en-US',
        transfer_phone: client.transfer_phone,
      },
      channels: {
        twilio_phone: client.twilio_phone,
        whatsapp_phone: client.whatsapp_phone,
        telegram_chat_id: client.telegram_chat_id,
        facebook_page_id: client.facebook_page_id,
        instagram_user_id: client.instagram_user_id,
      },
      booking: {
        calcom_booking_link: client.calcom_booking_link,
        calcom_event_type_id: client.calcom_event_type_id,
        google_review_link: client.google_review_link,
      },
      notifications: {
        notification_mode: client.notification_mode || 'all',
      },
      ai: {
        is_active: client.is_active,
        auto_followup_enabled: client.auto_followup_enabled,
      },
      billing: {
        plan: client.plan,
        subscription_status: client.subscription_status,
      },
      onboarding: {
        step: client.onboarding_step || 0,
        completed: client.onboarding_completed === 1,
      },
      referral: {
        code: client.referral_code,
      },
      webhooks: {
        lead_webhook_url: client.lead_webhook_url || null,
        booking_webhook_url: client.booking_webhook_url || null,
        call_webhook_url: client.call_webhook_url || null,
        sms_webhook_url: client.sms_webhook_url || null,
        stage_change_webhook_url: client.stage_change_webhook_url || null,
      },
    });
  } catch (err) {
    logger.error('[settings] Error:', err);
    next(err);
  }
});

// PUT /settings/:clientId — Update settings by category
router.put('/settings/:clientId', validateBody(SettingsUpdateSchema), async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;
    if (!isValidUUID(clientId)) return next(new AppError('INVALID_INPUT', 'Invalid client ID', 400));

    // Whitelist of updatable settings fields
    const ALLOWED = new Set([
      'business_name', 'owner_name', 'owner_phone', 'industry', 'timezone', 'avg_ticket',
      'retell_voice', 'retell_language', 'transfer_phone', 'whatsapp_phone',
      'calcom_booking_link', 'calcom_event_type_id', 'google_review_link',
      'notification_mode', 'is_active', 'auto_followup_enabled',
      'lead_webhook_url', 'booking_webhook_url', 'call_webhook_url',
      'sms_webhook_url', 'stage_change_webhook_url',
    ]);

    // Fields that require encryption before storage
    const ENCRYPTED_FIELDS = { facebook_page_token: 'facebook_page_token_encrypted', instagram_access_token: 'instagram_access_token_encrypted' };

    const body = req.body;
    const updates = [];
    const params = [];

    for (const [key, value] of Object.entries(body)) {
      if (ALLOWED.has(key)) {
        updates.push(`${key} = ?`);
        params.push(value);
      }
    }

    if (updates.length === 0) {
      return next(new AppError('VALIDATION_ERROR', 'No valid settings to update', 400));
    }

    updates.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(clientId);

    await db.query(`UPDATE clients SET ${updates.join(', ')} WHERE id = ?`, params, 'run');

    // Trigger sync to Retell AI if prompt-related fields changed
    const PROMPT_FIELDS = [
      'business_name', 'industry', 'owner_name', 'business_address', 
      'website', 'booking_link', 'calcom_booking_link', 'ticket_price',
      'transfer_phone'
    ];
    if (Object.keys(body).some(key => PROMPT_FIELDS.includes(key))) {
      syncClientToRetell(clientId, db).catch(err => {
        logger.error(`[settings] Failed to sync to Retell for ${clientId}:`, err.message);
      });
    }

    const acceptedValues = {};
    for (const k of Object.keys(body)) { if (ALLOWED.has(k)) acceptedValues[k] = body[k]; }
    try { logDataMutation(db, { action: 'settings_updated', table: 'clients', recordId: clientId, newValues: acceptedValues }); } catch (_) {}

    return success(res, { fields: Object.keys(body).filter(k => ALLOWED.has(k)) });
  } catch (err) {
    logger.error('[settings] Update error:', err);
    next(err);
  }
});

module.exports = router;
