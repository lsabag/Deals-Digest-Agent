import { Env, ClassifiedEmail, GmailMessage } from './types';
import { getHeader, getMessageBody, extractHeroImage } from './gmail';

const GROQ_API = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'llama-3.1-8b-instant';

const CLASSIFICATION_PROMPT = `אתה סוכן AI שמסווג אימיילים שיווקיים בעברית ואנגלית.
חשוב מאוד: קרא את כל תוכן המייל בעיון ותמצה את המבצעים הספציפיים, המחירים, וההנחות.

לכל אימייל, החזר JSON בפורמט הבא (ללא markdown, רק JSON טהור):
{
  "type": "simple" | "complex",
  "category": "ביגוד" | "מזון" | "טכנולוגיה" | "בית" | "יופי" | "בידור" | "אחר",
  "deals": [
    {
      "product": "שם המוצר הספציפי",
      "summary": "2-3 משפטים בעברית שמתארים את המבצע, מה כולל, ולמה כדאי",
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
- "product" = שם ספציפי (לא "מוצרי פסח" אלא "קופון 50 ש"ח על קניה מעל 200 ש"ח")
- "summary" = תיאור מפורט: מה המבצע, מה התנאים, עד מתי, מה הקופון אם יש. 2-3 משפטים!
- "interest_score" מ-1 עד 5 (5 = מבצע מעולה עם הנחה גדולה)
- "discount_pct" = אחוז ההנחה אם ניתן לחשב, אחרת null
- "price" ו-"original_price" בשקלים, null אם לא ניתן לדלות
- "spam_confidence" = 0.0-1.0, כמה סביר שזה ספאם/לא רלוונטי
- "emoji" = אימוג'י אחד שמייצג את הקטגוריה
- אם יש כמה מוצרים/מבצעים באותו מייל, הוצא כל אחד כ-deal נפרד
- תמיד החזר JSON תקין בלבד`;

export async function classifyEmails(
  messages: GmailMessage[], env: Env,
): Promise<ClassifiedEmail[]> {
  if (messages.length === 0) return [];

  const batchSize = 3;
  const results: ClassifiedEmail[] = [];

  for (let i = 0; i < messages.length; i += batchSize) {
    const batch = messages.slice(i, i + batchSize);
    const batchResults = await classifyBatch(batch, env);
    results.push(...batchResults);
    // Wait between batches to respect Groq rate limits
    if (i + batchSize < messages.length) {
      await new Promise(r => setTimeout(r, 15000));
    }
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
    const truncatedBody = body.length > 1500 ? body.substring(0, 1500) + '...' : body;

    return `--- אימייל ${idx + 1} ---
מאת: ${from}
נושא: ${subject}
תוכן: ${truncatedBody}`;
  }).join('\n\n');

  const userPrompt = `סווג את האימיילים הבאים. החזר JSON עם מפתח "emails" שמכיל מערך עם אובייקט לכל אימייל.
דוגמה: {"emails": [{...}, {...}]}
חשוב: תמצה פרטים ספציפיים — מחירים, שמות מוצרים, קופונים, תנאי מבצע.

${emailSummaries}`;

  const responseText = await callGroq(userPrompt, env);
  return parseResponse(responseText, messages);
}

async function callGroq(userPrompt: string, env: Env, retries = 2): Promise<string> {
  const res = await fetch(GROQ_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: CLASSIFICATION_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
    }),
  });

  if (res.status === 429 && retries > 0) {
    // Wait and retry
    await new Promise(r => setTimeout(r, 10000));
    return callGroq(userPrompt, env, retries - 1);
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq API error: ${res.status} ${err}`);
  }

  const data = await res.json() as {
    choices?: Array<{
      message?: { content?: string };
    }>;
  };

  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty Groq response');
  return text;
}

function parseResponse(
  responseText: string, messages: GmailMessage[],
): ClassifiedEmail[] {
  let cleaned = responseText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to find a JSON array
    const arrMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try { parsed = JSON.parse(arrMatch[0]); } catch {}
    }
    // Try to find a JSON object
    if (!parsed) {
      const objMatch = cleaned.match(/\{[\s\S]*\}/);
      if (objMatch) {
        try { parsed = JSON.parse(objMatch[0]); } catch {}
      }
    }
    if (!parsed) {
      console.error('Failed to parse response:', cleaned.substring(0, 500));
      return messages.map(msg => fallbackClassification(msg));
    }
  }

  // Handle {"emails": [...]} wrapper or plain array
  let unwrapped = parsed;
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    unwrapped = obj.emails || obj.results || obj.data || Object.values(obj)[0];
  }
  const arr = Array.isArray(unwrapped) ? unwrapped : [unwrapped];

  return messages.map((msg, idx) => {
    const classification = arr[idx] || {};
    const from = getHeader(msg, 'From') || 'unknown';
    const subject = getHeader(msg, 'Subject') || '';

    // Extract hero image from email HTML
    const body = getMessageBody(msg);
    const image = extractHeroImage(body);

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
      image,
    };
  });
}

function fallbackClassification(msg: GmailMessage): ClassifiedEmail {
  const from = getHeader(msg, 'From') || 'unknown';
  const subject = getHeader(msg, 'Subject') || '';
  const body = getMessageBody(msg);
  const image = extractHeroImage(body);

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
    image,
  };
}
