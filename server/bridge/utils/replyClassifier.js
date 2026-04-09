const Anthropic = require('@anthropic-ai/sdk');
const { z } = require('zod');
const config = require('./config');
const { logger } = require('./logger');

const ClassificationSchema = z.object({
  classification: z.enum(['INTERESTED', 'QUESTION', 'NOT_INTERESTED', 'UNSUBSCRIBE']),
  confidence: z.number().min(0).max(1),
  summary: z.string().max(500).optional(),
});

const anthropic = new Anthropic();

const DEFAULT_CLASSIFICATION = { classification: 'QUESTION', confidence: 0, summary: 'Classification failed — needs manual review' };

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
    const parsed = JSON.parse(cleaned);
    const validated = ClassificationSchema.safeParse(parsed);
    if (!validated.success) {
      logger.warn('[replyClassifier] Invalid Claude response shape:', validated.error.issues[0]?.message);
      return DEFAULT_CLASSIFICATION;
    }
    const result = validated.data;

    return result;
  } catch (err) {
    logger.error('[ReplyClassifier] Error:', err.message);
    return DEFAULT_CLASSIFICATION;
  }
}

module.exports = { classifyReply };
