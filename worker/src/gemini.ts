import { Env, ClassifiedEmail, GmailMessage } from './types';
import { getHeader, getMessageBody } from './gmail';

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

const CLASSIFICATION_PROMPT = `אתה סוכן AI שמסווג אימיילים שיווקיים בעברית ואנגלית.

לכל אימייל, החזר JSON בפורמט הבא (ללא markdown, רק JSON טהור):
{
  "type": "simple" | "complex",
  "category": "ביגוד" | "מזון" | "טכנולוגיה" | "בית" | "יופי" | "בידור" | "אחר",
  "deals": [
    {
      "product": "שם המוצר",
      "summary": "משפט סיכום אחד בעברית",
      "price": 149.90,
      "original_price": 299.90,
      "discount_pct": 50,
      "interest_score": 4,
      "emoji": "👗"
    }
  ],
  "spam_confidence": 0.1,
  "has_attachment": false
}

כללים:
- "type" = "simple" אם יש מבצע אחד, "complex" אם יש כמה מבצעים באותו מייל
- "interest_score" מ-1 עד 5 (5 = מבצע מעולה)
- "discount_pct" = אחוז ההנחה אם ניתן לחשב, אחרת null
- "price" ו-"original_price" בשקלים, null אם לא ניתן לדלות
- "spam_confidence" = 0.0-1.0, כמה סביר שזה ספאם/לא רלוונטי
- "emoji" = אימוג'י אחד שמייצג את הקטגוריה
- תמיד החזר JSON תקין בלבד`;

export async function classifyEmails(
  messages: GmailMessage[], env: Env,
): Promise<ClassifiedEmail[]> {
  if (messages.length === 0) return [];

  // Process in batches of 5 to stay within token limits
  const batchSize = 5;
  const results: ClassifiedEmail[] = [];

  for (let i = 0; i < messages.length; i += batchSize) {
    const batch = messages.slice(i, i + batchSize);
    const batchResults = await classifyBatch(batch, env);
    results.push(...batchResults);
  }

  return results;
}

async function classifyBatch(
  messages: GmailMessage[], env: Env,
): Promise<ClassifiedEmail[]> {
  const emailSummaries = messages.map((msg, idx) => {
    const from = getHeader(msg, 'From') || 'unknown';
    const subject = getHeader(msg, 'Subject') || '';
    const body = getMessageBody(msg);
    // Truncate body to save tokens
    const truncatedBody = body.length > 2000 ? body.substring(0, 2000) + '...' : body;

    return `--- אימייל ${idx + 1} ---
מאת: ${from}
נושא: ${subject}
תוכן: ${truncatedBody}`;
  }).join('\n\n');

  const prompt = `${CLASSIFICATION_PROMPT}

סווג את האימיילים הבאים. החזר מערך JSON (ללא markdown) עם אובייקט לכל אימייל:

${emailSummaries}`;

  const responseText = await callGemini(prompt, env);
  const parsed = parseGeminiResponse(responseText, messages);
  return parsed;
}

async function callGemini(prompt: string, env: Env): Promise<string> {
  const res = await fetch(`${GEMINI_API}?key=${env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: prompt }],
      }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 4096,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error: ${res.status} ${err}`);
  }

  const data = await res.json() as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty Gemini response');
  return text;
}

function parseGeminiResponse(
  responseText: string, messages: GmailMessage[],
): ClassifiedEmail[] {
  // Strip markdown code fences if present
  let cleaned = responseText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to extract JSON array from the response
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      parsed = JSON.parse(match[0]);
    } else {
      console.error('Failed to parse Gemini response:', cleaned);
      return messages.map(msg => fallbackClassification(msg));
    }
  }

  const arr = Array.isArray(parsed) ? parsed : [parsed];

  return messages.map((msg, idx) => {
    const classification = arr[idx] || {};
    const from = getHeader(msg, 'From') || 'unknown';
    const subject = getHeader(msg, 'Subject') || '';

    return {
      message_id: msg.id,
      sender: from,
      subject,
      type: classification.type || 'simple',
      category: classification.category || 'אחר',
      deals: (classification.deals || []).map((d: Record<string, unknown>) => ({
        product: d.product || subject,
        summary: d.summary || '',
        price: typeof d.price === 'number' ? d.price : null,
        original_price: typeof d.original_price === 'number' ? d.original_price : null,
        discount_pct: typeof d.discount_pct === 'number' ? d.discount_pct : null,
        interest_score: typeof d.interest_score === 'number' ? d.interest_score : 3,
        emoji: d.emoji || '🏷️',
      })),
      spam_confidence: classification.spam_confidence || 0,
      has_attachment: classification.has_attachment || false,
    };
  });
}

function fallbackClassification(msg: GmailMessage): ClassifiedEmail {
  const from = getHeader(msg, 'From') || 'unknown';
  const subject = getHeader(msg, 'Subject') || '';

  return {
    message_id: msg.id,
    sender: from,
    subject,
    type: 'simple',
    category: 'אחר',
    deals: [{
      product: subject,
      summary: msg.snippet || '',
      price: null,
      original_price: null,
      discount_pct: null,
      interest_score: 3,
      emoji: '🏷️',
    }],
    spam_confidence: 0,
    has_attachment: false,
  };
}
