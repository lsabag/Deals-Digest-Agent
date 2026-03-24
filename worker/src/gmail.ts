import { Env, User, GmailMessage } from './types';
import { getValidAccessToken } from './auth';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

// Whitelist: these senders/queries are always skipped (not deals)
const WHITELIST_QUERIES = [
  'from:me',
  'from:github.com',
  'from:supabase.com',
  'from:lovable.dev',
];

const WHITELIST_SUBJECTS = [
  'אישור תשלום',
  'חשבונית',
  'invoice',
];

const FINANCIAL_SENDERS = [
  'bank', 'visa', 'mastercard', 'max', 'cal', 'leumi', 'hapoalim', 'discount', 'mizrahi',
];

export async function fetchPromotionEmails(user: User, env: Env): Promise<GmailMessage[]> {
  const token = await getValidAccessToken(user, env);

  // Fetch promotions from last day, unread
  const query = 'category:promotions newer_than:1d is:unread';
  const messages = await searchMessages(token, query);

  // Fetch full message details in parallel (max 20)
  const toFetch = messages.slice(0, 20);
  const fullMessages = await Promise.all(
    toFetch.map(m => getMessageDetails(token, m.id)),
  );

  // Filter out whitelisted
  return fullMessages.filter(msg => !isWhitelisted(msg));
}

export async function fetchInvoiceEmails(user: User, env: Env): Promise<GmailMessage[]> {
  const token = await getValidAccessToken(user, env);
  const query = 'has:attachment (invoice OR חשבונית OR receipt OR קבלה) newer_than:1d';
  const messages = await searchMessages(token, query);
  const toFetch = messages.slice(0, 10);
  return Promise.all(toFetch.map(m => getMessageDetails(token, m.id)));
}

async function searchMessages(
  accessToken: string, query: string,
): Promise<Array<{ id: string; threadId: string }>> {
  const params = new URLSearchParams({ q: query, maxResults: '30' });
  const res = await fetch(`${GMAIL_API}/messages?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gmail search failed: ${err}`);
  }

  const data = await res.json() as { messages?: Array<{ id: string; threadId: string }> };
  return data.messages || [];
}

async function getMessageDetails(accessToken: string, messageId: string): Promise<GmailMessage> {
  const res = await fetch(`${GMAIL_API}/messages/${messageId}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) throw new Error(`Gmail get message failed: ${messageId}`);
  return res.json() as Promise<GmailMessage>;
}

function isWhitelisted(msg: GmailMessage): boolean {
  const from = getHeader(msg, 'From')?.toLowerCase() || '';
  const subject = getHeader(msg, 'Subject')?.toLowerCase() || '';

  // Skip financial senders
  if (FINANCIAL_SENDERS.some(s => from.includes(s))) return true;

  // Skip whitelisted senders
  if (WHITELIST_QUERIES.some(q => {
    const domain = q.replace('from:', '');
    return from.includes(domain);
  })) return true;

  // Skip whitelisted subjects
  if (WHITELIST_SUBJECTS.some(s => subject.includes(s.toLowerCase()))) return true;

  return false;
}

// --- Helpers ---

export function getHeader(msg: GmailMessage, name: string): string | undefined {
  return msg.payload.headers.find(
    h => h.name.toLowerCase() === name.toLowerCase(),
  )?.value;
}

export function getMessageBody(msg: GmailMessage): string {
  // Try to get HTML body first, then plain text
  if (msg.payload.parts) {
    // Multipart message
    const htmlPart = findPart(msg.payload.parts, 'text/html');
    if (htmlPart?.body?.data) return decodeBase64Url(htmlPart.body.data);

    const textPart = findPart(msg.payload.parts, 'text/plain');
    if (textPart?.body?.data) return decodeBase64Url(textPart.body.data);
  }

  // Simple message
  if (msg.payload.body?.data) return decodeBase64Url(msg.payload.body.data);

  return msg.snippet || '';
}

function findPart(
  parts: NonNullable<GmailMessage['payload']['parts']>,
  mimeType: string,
): NonNullable<GmailMessage['payload']['parts']>[0] | undefined {
  for (const part of parts) {
    if (part.mimeType === mimeType) return part;
    if (part.parts) {
      const found = findPart(part.parts as NonNullable<GmailMessage['payload']['parts']>, mimeType);
      if (found) return found;
    }
  }
  return undefined;
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

// Extract the best hero image from email HTML
// Skips tracking pixels, icons, and tiny images
export function extractHeroImage(html: string): string | null {
  const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let match;
  const candidates: string[] = [];

  while ((match = imgRegex.exec(html)) !== null) {
    const src = match[1];
    const tag = match[0].toLowerCase();

    // Skip tracking pixels and tiny images
    if (src.includes('track') || src.includes('pixel') || src.includes('beacon')
      || src.includes('open.') || src.includes('click.')
      || src.includes('1x1') || src.includes('spacer')) continue;

    // Skip data URIs and very short URLs
    if (src.startsWith('data:') || src.length < 20) continue;

    // Skip explicit 1x1 or tiny dimensions in the tag
    if (/width=["']?[01]/.test(tag) || /height=["']?[01]/.test(tag)) continue;

    // Prefer https images
    if (src.startsWith('https://')) {
      candidates.push(src);
    } else if (src.startsWith('http://')) {
      candidates.push(src);
    }
  }

  // Return first good candidate (promotional emails put hero image first/early)
  return candidates[0] || null;
}

export function extractSenderDomain(from: string): string {
  const match = from.match(/@([a-zA-Z0-9.-]+)/);
  return match ? match[1].toLowerCase() : from.toLowerCase();
}
