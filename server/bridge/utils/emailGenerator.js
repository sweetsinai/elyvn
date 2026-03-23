const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic();

async function generateColdEmail(prospect) {
  const { business_name, industry, city, state, rating, review_count, website } = prospect;

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: `You write cold outreach emails for ELYVN, an AI receptionist service for service businesses.
The emails must be:
- Personal (reference the business by name, their city, their industry)
- Short (under 150 words)
- One clear CTA: book a demo call
- No spam words (free, guaranteed, act now)
- Professional but warm
- Subject line under 50 chars

Return JSON only: {"subject": "...", "body": "..."}`,
      messages: [{
        role: 'user',
        content: `Write a cold email for:
Business: ${business_name}
Industry: ${industry || 'service business'}
City: ${city}${state ? ', ' + state : ''}
Rating: ${rating || 'N/A'}/5 (${review_count || 0} reviews)
Website: ${website || 'N/A'}

The email should mention how AI answering can help them never miss a call and convert more leads.`
      }]
    });

    const text = resp.content[0]?.text || '';
    const cleaned = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return { subject: parsed.subject, body: parsed.body };
  } catch (err) {
    console.error('[EmailGen] Error:', err.message);
    // Fallback template
    return {
      subject: `${business_name} — never miss a customer call again`,
      body: `Hi,\n\nI noticed ${business_name} in ${city} and wanted to reach out. We help ${industry || 'service'} businesses answer every call with AI — so you never lose a lead to voicemail.\n\nWould you be open to a quick 10-minute demo this week?\n\nBest,\nSohan\nELYVN`
    };
  }
}

module.exports = { generateColdEmail };
