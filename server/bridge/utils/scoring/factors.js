/**
 * Lead Scoring — Factor Calculations
 *
 * Individual scoring factors extracted from the main model.
 */

/**
 * Calculate responsiveness factor (0-100)
 * How fast did they respond to first outreach?
 */
function calcResponsiveness(messages, calls, firstOutreach) {
  let responsiveFactor = 0;
  let firstResponse = null;

  // Find first inbound response
  if (firstOutreach) {
    for (const msg of messages) {
      if (msg.direction === 'inbound' && new Date(msg.created_at) > firstOutreach) {
        firstResponse = new Date(msg.created_at);
        break;
      }
    }
    // Check if they answered a call within 2 hours
    if (!firstResponse) {
      for (const call of calls) {
        if (new Date(call.created_at) > firstOutreach && call.duration > 0) {
          firstResponse = new Date(call.created_at);
          break;
        }
      }
    }
  }

  if (firstResponse && firstOutreach) {
    const minutesToRespond = (firstResponse - firstOutreach) / 60000;
    if (minutesToRespond < 5) {
      responsiveFactor = 100;
    } else if (minutesToRespond < 30) {
      responsiveFactor = 90;
    } else if (minutesToRespond < 60) {
      responsiveFactor = 75;
    } else if (minutesToRespond < 240) {
      responsiveFactor = 60;
    } else if (minutesToRespond < 1440) {
      responsiveFactor = 40;
    } else {
      responsiveFactor = 20;
    }
  } else if (firstOutreach && (calls.length > 0 || messages.some(m => m.direction === 'inbound'))) {
    responsiveFactor = 50;
  } else if (calls.length > 0) {
    responsiveFactor = 70;
  }

  return { responsiveFactor, firstResponse };
}

/**
 * Calculate engagement factor (0-100)
 * How many interactions and patterns of engagement?
 */
function calcEngagement(calls, messages) {
  let engagementFactor = 0;
  const totalInteractions = calls.length + messages.length;
  const inboundMessages = messages.filter(m => m.direction === 'inbound').length;

  if (totalInteractions === 0) {
    engagementFactor = 0;
  } else if (totalInteractions >= 5) {
    engagementFactor = 100;
  } else if (totalInteractions >= 3) {
    engagementFactor = 80;
  } else if (totalInteractions >= 2) {
    engagementFactor = 60;
  } else {
    engagementFactor = 40;
  }

  if (inboundMessages > 0) {
    engagementFactor = Math.min(100, engagementFactor + 15);
  }

  return { engagementFactor, totalInteractions, inboundMessages };
}

/**
 * Calculate intent signals factor (0-100)
 * Source quality, sentiment, call outcomes
 */
function calcIntent(lead, calls, messages) {
  let intentFactor = 0;
  let signalCount = 0;

  const leadSource = lead.source || 'sms';
  if (leadSource === 'form') {
    intentFactor += 30;
    signalCount += 1;
  } else if (leadSource === 'missed_call') {
    intentFactor += 20;
    signalCount += 1;
  } else if (leadSource === 'sms') {
    intentFactor += 10;
    signalCount += 1;
  }

  if (messages.length > 0) {
    const lastCallWithSentiment = [...calls].reverse().find(c => c.sentiment);
    if (lastCallWithSentiment) {
      const sentimentMap = { positive: 3, neutral: 1, negative: -2 };
      const sentimentValue = sentimentMap[lastCallWithSentiment.sentiment] ?? (parseInt(lastCallWithSentiment.sentiment) || 0);
      intentFactor += sentimentValue * 10;
      signalCount += 1;
    }
  }

  const qualifiedCalls = calls.filter(c => c.outcome === 'qualified' || c.outcome === 'booked').length;
  if (qualifiedCalls > 0) {
    intentFactor += 35;
    signalCount += 1;
  } else {
    const answeredCalls = calls.filter(c => c.duration > 30).length;
    if (answeredCalls > 0) {
      intentFactor += 20;
      signalCount += 1;
    }
  }

  if (signalCount > 0) {
    intentFactor = Math.min(100, intentFactor / signalCount);
  } else {
    const fallbackScore = Math.min(100, Math.max(0, ((Number(lead.score) || 0) / 10) * 100));
    intentFactor = fallbackScore || 20;
  }

  return { intentFactor, qualifiedCalls };
}

/**
 * Calculate recency factor (0-100)
 * How recently have they engaged?
 */
function calcRecency(messages, calls) {
  const lastInteractionTime = messages.length > 0 || calls.length > 0
    ? Math.max(
        messages.length > 0 ? new Date(messages[messages.length - 1].created_at).getTime() : 0,
        calls.length > 0 ? new Date(calls[calls.length - 1].created_at).getTime() : 0
      )
    : null;

  let recencyFactor = 0;

  if (!lastInteractionTime) {
    recencyFactor = 0;
  } else {
    const hoursSinceContact = (Date.now() - lastInteractionTime) / 3600000;
    if (hoursSinceContact < 1) {
      recencyFactor = 100;
    } else if (hoursSinceContact < 24) {
      recencyFactor = 90;
    } else if (hoursSinceContact < 72) {
      recencyFactor = 75;
    } else if (hoursSinceContact < 168) {
      recencyFactor = 60;
    } else if (hoursSinceContact < 336) {
      recencyFactor = 40;
    } else if (hoursSinceContact < 720) {
      recencyFactor = 20;
    } else {
      recencyFactor = 5;
    }
  }

  return { recencyFactor, lastInteractionTime };
}

/**
 * Calculate channel diversity factor (0-100)
 * Have they engaged via multiple channels?
 */
function calcChannelDiversity(calls, messages) {
  const hasPhoneCalls = calls.length > 0;
  const hasSMS = messages.length > 0;
  const channelsUsed = (hasPhoneCalls ? 1 : 0) + (hasSMS ? 1 : 0);

  let channelFactor = 0;
  if (channelsUsed === 2) {
    channelFactor = 100;
  } else if (channelsUsed === 1) {
    channelFactor = 60;
  }

  return { channelFactor };
}

/**
 * Calculate AI scoring factor (0-100)
 * Bridges the 1-10 AI scores from calls into the 0-100 model.
 */
function calcAiScore(lead, calls) {
  let aiFactor = 0;
  const scores = calls.filter(c => c.score > 0).map(c => c.score);
  
  if (scores.length > 0) {
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    // Scale 1-10 to 0-100. 1 -> 10, 10 -> 100.
    aiFactor = Math.min(100, Math.max(0, avgScore * 10));
  } else if (lead.score > 0) {
    // Fallback to lead-level score if no calls have scores
    aiFactor = Math.min(100, Math.max(0, lead.score * 10));
  }

  return { aiFactor };
}

module.exports = {
  calcResponsiveness,
  calcEngagement,
  calcIntent,
  calcRecency,
  calcChannelDiversity,
  calcAiScore,
};
