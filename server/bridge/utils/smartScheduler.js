/**
 * Smart Contact Scheduler
 * Optimizes when to contact leads based on historical success patterns
 */

/**
 * Get the optimal time to contact a specific lead
 * @param {object} db
 * @param {string} leadId
 * @param {string} clientId
 * @returns {{ optimal_hour: number, optimal_day: string, confidence: number, reason: string }}
 */
async function getOptimalContactTime(db, leadId, clientId) {
  if (!leadId || !clientId) {
    return null;
  }

  const lead = await db.query(
    'SELECT phone FROM leads WHERE id = ? AND client_id = ?',
    [leadId, clientId], 'get'
  );

  if (!lead) {
    return null;
  }

  // Get all interactions for this lead
  const calls = await db.query(
    `SELECT created_at, outcome, score FROM calls
     WHERE caller_phone = ? AND client_id = ?
     ORDER BY created_at DESC LIMIT 20`,
    [lead.phone, clientId]
  );

  const messages = await db.query(
    `SELECT created_at, status FROM messages
     WHERE phone = ? AND client_id = ?
     ORDER BY created_at DESC LIMIT 20`,
    [lead.phone, clientId]
  );

  // Analyze successful interactions
  const successfulTimes = [];
  const allTimes = [];

  // Analyze calls
  for (const call of calls) {
    const date = new Date(call.created_at);
    const hour = date.getHours();
    const day = date.toLocaleDateString('en-US', { weekday: 'long' });

    allTimes.push({ hour, day, type: 'call' });

    // Track successful calls
    if (call.outcome === 'booked' || call.outcome === 'qualified' || (call.score && call.score >= 6)) {
      successfulTimes.push({ hour, day, type: 'call' });
    }
  }

  // Analyze messages
  for (const msg of messages) {
    const date = new Date(msg.created_at);
    const hour = date.getHours();
    const day = date.toLocaleDateString('en-US', { weekday: 'long' });

    allTimes.push({ hour, day, type: 'message' });
  }

  // Find optimal hour
  let optimal_hour = 10; // Default to 10 AM
  let optimal_day = 'Monday'; // Default to Monday
  let confidence = 0.5; // Default confidence

  if (successfulTimes.length > 0) {
    // Calculate hour distribution
    const hourCounts = {};
    successfulTimes.forEach(t => {
      hourCounts[t.hour] = (hourCounts[t.hour] || 0) + 1;
    });

    // Find most successful hour
    const sortedHours = Object.entries(hourCounts)
      .sort((a, b) => b[1] - a[1]);

    if (sortedHours.length > 0) {
      optimal_hour = parseInt(sortedHours[0][0]);
      const rawConfidence = Math.min(0.95, (sortedHours[0][1] / successfulTimes.length) + 0.3);
      // P2: Sample size confidence penalty — full confidence only after 5+ samples
      const sampleSize = successfulTimes.length || 0;
      const samplePenalty = Math.min(1.0, sampleSize / 5.0);
      confidence = Math.min(0.95, rawConfidence * samplePenalty);
    }

    // Calculate day distribution
    const dayCounts = {};
    successfulTimes.forEach(t => {
      dayCounts[t.day] = (dayCounts[t.day] || 0) + 1;
    });

    const sortedDays = Object.entries(dayCounts)
      .sort((a, b) => b[1] - a[1]);

    if (sortedDays.length > 0) {
      optimal_day = sortedDays[0][0];
    }
  } else if (allTimes.length > 0) {
    // No successful interactions, use general patterns
    const hourCounts = {};
    allTimes.forEach(t => {
      hourCounts[t.hour] = (hourCounts[t.hour] || 0) + 1;
    });

    const sortedHours = Object.entries(hourCounts)
      .sort((a, b) => b[1] - a[1]);

    if (sortedHours.length > 0) {
      optimal_hour = parseInt(sortedHours[0][0]);
      confidence = Math.min(0.6, (sortedHours[0][1] / allTimes.length) + 0.1);
    }
  }

  // Build reason
  let reason = 'Based on ';
  if (successfulTimes.length > 2) {
    reason += `${successfulTimes.length} successful interactions at this time`;
  } else if (allTimes.length > 0) {
    reason += `${allTimes.length} prior interactions; no successful patterns detected yet`;
  } else {
    reason += 'industry best practices (no lead history available)';
  }

  return {
    optimal_hour,
    optimal_day,
    confidence: Math.round(confidence * 100) / 100,
    reason,
  };
}

/**
 * Generate a daily contact schedule prioritized by conversion probability
 * @param {object} db
 * @param {string} clientId
 * @returns {Array<{leadId, phone, name, scheduled_time, priority, reason}>}
 */
async function generateDailySchedule(db, clientId) {
  if (!clientId) {
    return [];
  }

  // Get all leads that should be contacted today
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const leads = await db.query(
    `SELECT id, phone, name, score, stage, updated_at FROM leads
     WHERE client_id = ? AND stage NOT IN ('booked', 'completed', 'lost')
     AND updated_at < ?
     ORDER BY score DESC LIMIT 20`,
    [clientId, oneDayAgo]
  );

  const schedule = [];
  let currentHour = 10; // Start at 10 AM

  for (const lead of leads) {
    // Get conversion probability for this lead
    const calls = await db.query(
      `SELECT COUNT(*) as count FROM calls
       WHERE caller_phone = ? AND client_id = ? AND outcome IN ('booked', 'qualified')`,
      [lead.phone, clientId], 'get'
    );

    const totalInteractionsRows = await db.query(
      `SELECT COUNT(*) as count FROM calls WHERE caller_phone = ? AND client_id = ?`,
      [lead.phone, clientId]
    );
    const totalInteractions = totalInteractionsRows[0]?.count || 1;

    const successRate = totalInteractions > 0
      ? (calls?.count || 0) / totalInteractions
      : 0;

    // Calculate priority (0-10 scale)
    const priority = Math.min(10, (lead.score || 0) + (successRate * 3));

    // Determine scheduled time (spread throughout day, 9 AM to 5 PM)
    const hour = Math.max(9, Math.min(17, currentHour));
    const minutes = Math.floor(Math.random() * 60); // Random minutes for natural distribution
    const scheduledTime = new Date();
    scheduledTime.setHours(hour, minutes, 0, 0);

    schedule.push({
      leadId: lead.id,
      phone: lead.phone,
      name: lead.name || 'Unknown',
      scheduled_time: scheduledTime.toISOString(),
      priority: Math.round(priority * 100) / 100,
      reason: `Lead score: ${lead.score}, Success rate: ${Math.round(successRate * 100)}%`,
    });

    // Increment hour for next lead (skip lunch hour 12-1 PM)
    currentHour++;
    if (currentHour === 12) currentHour = 13;
    if (currentHour > 17) {
      currentHour = 9; // Wrap to next batch
    }
  }

  // Sort by priority (highest first)
  return schedule.sort((a, b) => b.priority - a.priority);
}

/**
 * Analyze what time slots have highest success rates
 * @param {object} db
 * @param {string} clientId
 * @returns {{ slots: Array<{hour, success_rate, sample_size}>, recommendation: string }}
 */
async function analyzeTimeSlotSuccess(db, clientId) {
  if (!clientId) {
    return null;
  }

  // Get all calls with outcomes
  const calls = await db.query(
    `SELECT created_at, outcome FROM calls WHERE client_id = ?`,
    [clientId]
  );

  // Group by hour
  const slots = {};

  for (const call of calls) {
    const date = new Date(call.created_at);
    const hour = date.getHours();

    if (!slots[hour]) {
      slots[hour] = { total: 0, booked: 0, success_rate: 0, sample_size: 0 };
    }

    slots[hour].total++;
    slots[hour].sample_size = slots[hour].total;

    // Consider 'booked' and 'qualified' as success
    if (call.outcome === 'booked' || call.outcome === 'qualified') {
      slots[hour].booked++;
    }
  }

  // Calculate success rates
  const slotArray = [];
  for (const hour in slots) {
    const slot = slots[hour];
    slot.success_rate = slot.total > 0
      ? Math.round((slot.booked / slot.total) * 10000) / 100
      : 0;

    slotArray.push({
      hour: parseInt(hour),
      success_rate: slot.success_rate,
      sample_size: slot.sample_size,
    });
  }

  // Sort by success rate
  slotArray.sort((a, b) => b.success_rate - a.success_rate);

  // Generate recommendation
  let recommendation = 'No call data available';

  if (slotArray.length > 0) {
    const topSlot = slotArray[0];
    const timeLabel = topSlot.hour === 12 ? '12 PM' :
                      topSlot.hour > 12 ? `${topSlot.hour - 12} PM` :
                      `${topSlot.hour} AM`;

    if (topSlot.sample_size >= 5) {
      recommendation = `Best: ${timeLabel} (${topSlot.success_rate}% success rate, n=${topSlot.sample_size})`;
    } else if (topSlot.sample_size >= 2) {
      recommendation = `Promising: ${timeLabel} (${topSlot.success_rate}%, limited data - n=${topSlot.sample_size})`;
    } else {
      recommendation = `Insufficient data for reliable recommendations`;
    }

    // Add avoid recommendation
    const worstSlot = slotArray[slotArray.length - 1];
    if (worstSlot.sample_size >= 5) {
      const avoidLabel = worstSlot.hour === 12 ? '12 PM' :
                         worstSlot.hour > 12 ? `${worstSlot.hour - 12} PM` :
                         `${worstSlot.hour} AM`;
      recommendation += `. Avoid: ${avoidLabel} (${worstSlot.success_rate}% success rate)`;
    }
  }

  return {
    slots: slotArray.slice(0, 24), // All hours
    recommendation,
  };
}

/**
 * Get optimal contact times for all leads (batch operation)
 * @param {object} db
 * @param {string} clientId
 * @returns {Array<{leadId, phone, optimal_hour, optimal_day}>}
 */
async function getOptimalTimesForAllLeads(db, clientId) {
  if (!clientId) {
    return [];
  }

  const leads = await db.query(
    'SELECT id FROM leads WHERE client_id = ?',
    [clientId]
  );

  const results = [];
  for (const lead of leads) {
    const timing = await getOptimalContactTime(db, lead.id, clientId);
    if (timing) {
      results.push({
        leadId: lead.id,
        ...timing,
      });
    }
  }
  return results;
}

module.exports = {
  getOptimalContactTime,
  generateDailySchedule,
  analyzeTimeSlotSuccess,
  getOptimalTimesForAllLeads,
};
