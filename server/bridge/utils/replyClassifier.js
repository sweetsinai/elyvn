const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic();

async function classifyReply(emailBody, originalSubject) {
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      system: `Classify this email reply into exactly one category. Return JSON only:
{"classification": "INTERESTED" | "QUESTION" | "NOT_INTERESTED" | "UNSUBSCRIBE", "summary": "one sentence summary"}

INTERESTED: wants to learn more, book a call, see a demo
QUESTION: has a question but not clearly interested or disinterested
NOT_INTERESTED: politely or directly declines
UNSUBSCRIBE: asks to be removed, stop emailing, etc.`,
      messages: [{
        role: 'user',
        content: `Original subject: ${originalSubject || 'N/A'}\n\nReply:\n${emailBody}`
      }]
    });

    const text = resp.content[0]?.text || '';
    const cleaned = text.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('[ReplyClassifier] Error:', err.message);
    return { classification: 'QUESTION', summary: 'Classification failed — needs manual review' };
  }
}

module.exports = { classifyReply };
