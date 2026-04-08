/**
 * Grounding Enforcer — validates brain actions against actual lead data
 * before execution, preventing hallucinated content from reaching leads.
 */

const { logger } = require('./logger');

// Date/time patterns: "Monday", "Tuesday", specific dates, "tomorrow", "today", times like "3pm", "10:00 AM"
const DATE_TIME_PATTERNS = [
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}/i,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/,
  /\b\d{1,2}:\d{2}\s*(?:am|pm)?\b/i,
  /\btomorrow\b/i,
  /\btoday\b/i,
  /\bnext\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week)\b/i,
  /\byour appointment (?:is|at|on)\b/i,
];

// Fabricated urgency phrases that reference non-existent appointments
const URGENCY_PATTERNS = [
  /your appointment is (?:tomorrow|today|this)/i,
  /don't forget your (?:appointment|booking|session)/i,
  /reminder:?\s+you(?:'re| are) (?:booked|scheduled)/i,
  /we have you (?:booked|scheduled|down) for/i,
];

// Price patterns: "$99", "$149.99", "starting at $", etc.
const PRICE_PATTERN = /\$\d+(?:\.\d{2})?/;

/**
 * Extract the text content from a brain action for grounding checks.
 */
function getMessageText(action) {
  return action.message || action.body || '';
}

/**
 * Check if a date/time reference in the message exists in the timeline.
 * Returns an array of date/time strings found in the message that are NOT in the timeline.
 */
function findUngroundedDateReferences(messageText, timeline) {
  const timelineText = (timeline || []).map(t => {
    const parts = [t.timestamp || '', t.summary || '', t.body || '', t.reply || '', t.content || '', t.outcome || ''];
    return parts.join(' ');
  }).join(' ').toLowerCase();

  const violations = [];

  for (const pattern of DATE_TIME_PATTERNS) {
    const matches = messageText.match(new RegExp(pattern, 'gi'));
    if (matches) {
      for (const match of matches) {
        // Check if this date/time reference appears somewhere in the timeline
        if (!timelineText.includes(match.toLowerCase())) {
          violations.push(`Date/time reference "${match}" not found in timeline`);
        }
      }
    }
  }

  return violations;
}

/**
 * Check if the message references prices/services not in the knowledge base or lead data.
 */
function findUngroundedClaims(messageText, leadData, knowledgeBase) {
  const violations = [];

  // Check for price claims
  const priceMatches = messageText.match(new RegExp(PRICE_PATTERN, 'g'));
  if (priceMatches) {
    const kbText = (knowledgeBase || '').toLowerCase();
    const leadText = JSON.stringify(leadData || {}).toLowerCase();
    for (const price of priceMatches) {
      if (!kbText.includes(price) && !leadText.includes(price)) {
        violations.push(`Price claim "${price}" not found in knowledge base or lead data`);
      }
    }
  }

  return violations;
}

/**
 * Check if the message references a previous interaction that doesn't exist.
 */
function findFabricatedInteractionRefs(messageText, timeline) {
  const violations = [];

  // Check for "as we discussed", "as I mentioned", "when you called", "your last visit"
  const interactionRefPatterns = [
    /as (?:we|I) (?:discussed|mentioned|talked about)/i,
    /when you (?:called|visited|came in|stopped by)/i,
    /your (?:last|previous|recent) (?:visit|call|appointment)/i,
    /following up on (?:our|your|the) (?:conversation|call|visit|chat)/i,
  ];

  // Only flag these if timeline is empty (no interactions exist)
  if (!timeline || timeline.length === 0) {
    for (const pattern of interactionRefPatterns) {
      if (pattern.test(messageText)) {
        violations.push(`References prior interaction but timeline is empty`);
      }
    }
  }

  return violations;
}

/**
 * Check for fabricated urgency about non-existent appointments.
 */
function findFabricatedUrgency(messageText, timeline) {
  const violations = [];

  // Check if any booking/appointment exists in timeline
  const hasBooking = (timeline || []).some(t =>
    t.type === 'booking' || t.type === 'appointment' ||
    (t.outcome && t.outcome === 'booked') ||
    (t.summary && /book/i.test(t.summary))
  );

  for (const pattern of URGENCY_PATTERNS) {
    if (pattern.test(messageText)) {
      if (!hasBooking) {
        violations.push(`Fabricated urgency about appointment, but no booking exists in timeline`);
      }
    }
  }

  return violations;
}

/**
 * Validate stage transitions.
 * Legal transitions: new->interested, interested->qualified, qualified->booked,
 * any->not_interested, any->lost.
 * Also allow the existing stage values used by the system.
 */
const LEGAL_STAGE_TRANSITIONS = {
  new:        ['contacted', 'interested', 'warm', 'not_interested', 'lost'],
  contacted:  ['interested', 'warm', 'not_interested', 'lost'],
  interested: ['qualified', 'warm', 'hot', 'not_interested', 'lost'],
  warm:       ['hot', 'qualified', 'not_interested', 'lost'],
  hot:        ['qualified', 'booked', 'not_interested', 'lost'],
  qualified:  ['booked', 'hot', 'not_interested', 'lost'],
  booked:     ['completed', 'lost'],
  completed:  ['nurture', 'lost'],
  nurture:    ['interested', 'warm', 'contacted', 'lost'],
  lost:       ['new', 'nurture'],
};

/**
 * Validate a brain action against the timeline and lead data.
 *
 * @param {object} action - The brain action to validate
 * @param {Array} timeline - The lead's interaction timeline
 * @param {object} leadData - The lead record
 * @param {string} [knowledgeBase] - The client knowledge base text
 * @returns {{ valid: boolean, violations: string[] }}
 */
function validateBrainAction(action, timeline, leadData, knowledgeBase) {
  const violations = [];

  if (!action || !action.action) {
    return { valid: false, violations: ['Missing action type'] };
  }

  // --- send_sms / send_email grounding checks ---
  if (action.action === 'send_sms' || action.action === 'send_email') {
    const messageText = getMessageText(action);
    if (!messageText) {
      violations.push('Empty message body');
    } else {
      violations.push(...findUngroundedDateReferences(messageText, timeline));
      violations.push(...findUngroundedClaims(messageText, leadData, knowledgeBase));
      violations.push(...findFabricatedInteractionRefs(messageText, timeline));
      violations.push(...findFabricatedUrgency(messageText, timeline));
    }
  }

  // --- schedule_followup checks ---
  if (action.action === 'schedule_followup') {
    const delayHours = action.delay_hours;
    if (typeof delayHours !== 'number' || delayHours < 1 || delayHours > 168) {
      violations.push(`delay_hours=${delayHours} out of range (must be 1-168)`);
    }
    if (!action.message && !action.reason) {
      violations.push('schedule_followup missing both message and reason');
    }
  }

  // --- update_lead_stage transition checks ---
  if (action.action === 'update_lead_stage') {
    const currentStage = leadData?.stage || 'new';
    const targetStage = action.stage;

    if (targetStage && currentStage !== targetStage) {
      const allowed = LEGAL_STAGE_TRANSITIONS[currentStage];
      if (allowed && !allowed.includes(targetStage)) {
        violations.push(`Illegal stage transition: ${currentStage} -> ${targetStage}`);
      }
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

module.exports = { validateBrainAction };
