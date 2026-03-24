import { Env, FeedbackEntry } from './types';

// --- Feedback ---

export async function saveFeedback(env: Env, entry: FeedbackEntry): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO feedback (user_id, message_id, sender, subject, category, liked)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
  `).bind(
    entry.user_id,
    entry.message_id,
    entry.sender,
    entry.subject,
    entry.category,
    entry.liked,
  ).run();
}

export async function getUserFeedback(env: Env, userId: string): Promise<FeedbackEntry[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM feedback WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 500',
  ).bind(userId).all<FeedbackEntry>();
  return results;
}

export async function getFeedbackStats(env: Env, userId: string) {
  const { results } = await env.DB.prepare(`
    SELECT sender,
           SUM(CASE WHEN liked = 1 THEN 1 ELSE 0 END) as likes,
           SUM(CASE WHEN liked = 0 THEN 1 ELSE 0 END) as dislikes,
           COUNT(*) as total
    FROM feedback WHERE user_id = ?1
    GROUP BY sender ORDER BY total DESC
  `).bind(userId).all();
  return results;
}

// --- Mutes ---

interface MuteRow {
  sender: string;
  mute_type: string;
  category: string | null;
  until: string | null;
}

export async function getUserMutes(env: Env, userId: string): Promise<MuteRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT sender, mute_type, category, until FROM mutes WHERE user_id = ?1',
  ).bind(userId).all<MuteRow>();
  return results;
}

export async function addMute(
  env: Env, userId: string, sender: string, muteType: string, category?: string, until?: string,
): Promise<void> {
  await env.DB.prepare(`
    INSERT OR REPLACE INTO mutes (user_id, sender, mute_type, category, until)
    VALUES (?1, ?2, ?3, ?4, ?5)
  `).bind(userId, sender, muteType, category || null, until || null).run();
}

export function isMuted(sender: string, mutes: MuteRow[]): boolean {
  const now = new Date().toISOString();
  return mutes.some(m => {
    if (m.sender !== sender) return false;
    if (m.mute_type === 'permanent') return true;
    if (m.mute_type === 'temporary' && m.until && m.until > now) return true;
    return false;
  });
}

// --- Digest cache ---

export async function getCachedDigest(env: Env, userId: string, date: string): Promise<string | null> {
  const row = await env.DB.prepare(
    'SELECT payload FROM digest_cache WHERE user_id = ?1 AND date = ?2',
  ).bind(userId, date).first<{ payload: string }>();
  return row?.payload || null;
}

export async function cacheDigest(env: Env, userId: string, date: string, payload: string): Promise<void> {
  await env.DB.prepare(`
    INSERT OR REPLACE INTO digest_cache (user_id, date, payload)
    VALUES (?1, ?2, ?3)
  `).bind(userId, date, payload).run();
}

// --- Price history ---

export async function savePriceHistory(
  env: Env, userId: string, productName: string, price: number,
  currency: string, sender: string, messageId: string,
): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO price_history (user_id, product_name, price, currency, sender, message_id)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
  `).bind(userId, productName, price, currency, sender, messageId).run();
}
