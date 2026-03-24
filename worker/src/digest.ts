import { Env, User, DigestCard, ClassifiedEmail } from './types';
import { fetchPromotionEmails } from './gmail';
import { classifyEmails } from './gemini';
import { getUserFeedback, getUserMutes, isMuted, getCachedDigest, cacheDigest } from './db';

export async function generateDigest(user: User, env: Env): Promise<DigestCard[]> {
  const today = new Date().toISOString().split('T')[0];

  // Check cache first
  const cached = await getCachedDigest(env, user.id, today);
  if (cached) {
    return JSON.parse(cached) as DigestCard[];
  }

  // Fetch emails from Gmail
  const emails = await fetchPromotionEmails(user, env);
  if (emails.length === 0) return [];

  // Classify with Gemini
  const classified = await classifyEmails(emails, env);

  // Load user preferences for scoring
  const [feedback, mutes] = await Promise.all([
    getUserFeedback(env, user.id),
    getUserMutes(env, user.id),
  ]);

  // Score and sort
  const cards: DigestCard[] = classified
    .map(email => toDigestCard(email, feedback, mutes))
    .filter(card => card.score > -50) // filter muted
    .sort((a, b) => b.score - a.score);

  // Cache result
  await cacheDigest(env, user.id, today, JSON.stringify(cards));

  return cards;
}

function toDigestCard(
  email: ClassifiedEmail,
  feedback: Array<{ sender: string; liked: number }>,
  mutes: Array<{ sender: string; mute_type: string; category: string | null; until: string | null }>,
): DigestCard {
  // Base score: average interest_score from deals
  const avgScore = email.deals.length > 0
    ? email.deals.reduce((sum, d) => sum + d.interest_score, 0) / email.deals.length
    : 3;

  let score = avgScore;

  // Adjust by sender feedback history
  const senderFeedback = feedback.filter(f => f.sender === email.sender);
  if (senderFeedback.length > 0) {
    const likeRatio = senderFeedback.filter(f => f.liked === 1).length / senderFeedback.length;
    score += (likeRatio - 0.5) * 4; // -2 to +2
  }

  // Muted senders get buried
  if (isMuted(email.sender, mutes)) {
    score = -99;
  }

  // Boost high discounts
  const maxDiscount = Math.max(...email.deals.map(d => d.discount_pct || 0));
  if (maxDiscount >= 50) score += 1;
  if (maxDiscount >= 70) score += 1;

  return {
    message_id: email.message_id,
    sender: email.sender,
    subject: email.subject,
    category: email.category,
    deals: email.deals,
    score: Math.round(score * 10) / 10,
    type: email.type,
    image: email.image,
  };
}

// Called by cron trigger
export async function runDigestForAllUsers(env: Env): Promise<void> {
  const { results: users } = await env.DB.prepare(
    'SELECT * FROM users WHERE refresh_token IS NOT NULL',
  ).all<User>();

  for (const user of users) {
    try {
      await generateDigest(user, env);
    } catch (err) {
      console.error(`Digest failed for user ${user.id}:`, err);
    }
  }
}
