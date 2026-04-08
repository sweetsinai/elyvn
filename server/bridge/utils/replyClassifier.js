const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const { logger } = require('./logger');

const anthropic = new Anthropic();

const VALID_CLASSIFICATIONS = ['INTERESTED', 'QUESTION', 'NOT_INTERESTED', 'UNSUBSCRIBE'];

async function classifyReply(emailBody, originalSubject) {
  // P1: Input sanitization — cap lengths before inserting into prompt
  const safeSubject = (originalSubject || '').substring(0, 200);
  const safeBody = (emailBody || '').substring(0, 3000);

  try {
    const resp = await anthropic.messages.create({
      model: config.ai.model,
      max_tokens: 150,
      system: `Classify this email reply into exactly one category. Return JSON only:
{"classification": "INTERESTED" | "QUESTION" | "NOT_INTERESTED" | "UNSUBSCRIBE", "confidence": 0.0-1.0, "summary": "one sentence summary"}

confidence: how certain you are in this classification (0.0 = no idea, 1.0 = absolutely certain).

INTERESTED: wants to learn more, book a call, see a demo
QUESTION: has a question but not clearly interested or disinterested
NOT_INTERESTED: politely or directly declines
UNSUBSCRIBE: asks to be removed, stop emailing, etc.`,
      messages: [{
        role: 'user',
        content: `Original subject: ${safeSubject || 'N/A'}\n\nReply:\n${safeBody}`
      }]
    });

    const text = resp.content[0]?.text || '';
    const cleaned = text.replace(/```json|```/g, '').trim();
    const result = JSON.parse(cleaned);

    // P0: Output validation
    if (!result || typeof result !== 'object') {
      throw new Error('Invalid response: expected object');
    }
    if (!VALID_CLASSIFICATIONS.includes(result.classification)) {
      logger.warn(`[replyClassifier] Unexpected classification "${result.classification}" — defaulting to QUESTION`);
      result.classification = 'QUESTION';
    }
    if (typeof result.summary !== 'string') {
      result.summary = '';
    }
    result.summary = result.summary.substring(0, 500);

    // Normalize confidence to a number between 0 and 1
    if (typeof result.confidence !== 'number' || isNaN(result.confidence)) {
      result.confidence = 0.5; // uncertain if model didn't return it
    }
    result.confidence = Math.max(0, Math.min(1, result.confidence));

    return result;
  } catch (err) {
    logger.error('[ReplyClassifier] Error:', err.message);
    return { classification: 'QUESTION', confidence: 0, summary: 'Classification failed — needs manual review' };
  }
}

module.exports = { classifyReply };
