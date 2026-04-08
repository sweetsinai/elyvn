const { speedToLeadSms, speedToLeadCallback } = require('../jobs/handlers/speedToLead');
const { followupSms, appointmentReminder } = require('../jobs/handlers/appointmentReminder');
const { interestedFollowupEmail, noreplyFollowup } = require('../jobs/handlers/followupEmail');
const { googleReviewRequest } = require('../jobs/handlers/reviewRequest');

// Create job handlers object
function createJobHandlers(db, sendSMS, captureException) {
  return {
    'speed_to_lead_sms': (payload) => speedToLeadSms(db, sendSMS, payload),
    'speed_to_lead_callback': (payload) => speedToLeadCallback(db, sendSMS, captureException, payload),
    'followup_sms': (payload) => followupSms(db, sendSMS, payload),
    'appointment_reminder': (payload) => appointmentReminder(db, sendSMS, payload),
    'interested_followup_email': (payload) => interestedFollowupEmail(db, captureException, payload),
    'noreply_followup': (payload) => noreplyFollowup(db, captureException, payload),
    'google_review_request': (payload, jobId) => googleReviewRequest(payload, jobId, db),
  };
}

module.exports = { createJobHandlers };
