export interface Env {
  DB: D1Database;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GEMINI_API_KEY: string;
  JWT_SECRET: string;
  WORKER_URL?: string;
}

export interface User {
  id: string;
  email: string;
  access_token: string | null;
  refresh_token: string;
  token_expiry: number | null;
}

export interface Deal {
  product: string;
  summary: string;
  price: number | null;
  original_price: number | null;
  discount_pct: number | null;
  interest_score: number;
  emoji: string;
}

export interface ClassifiedEmail {
  message_id: string;
  sender: string;
  subject: string;
  type: 'simple' | 'complex' | 'invoice' | 'spam_suspicious';
  category: string;
  deals: Deal[];
  spam_confidence: number;
  has_attachment: boolean;
}

export interface DigestCard {
  message_id: string;
  sender: string;
  subject: string;
  category: string;
  deals: Deal[];
  score: number;
  type: 'simple' | 'complex' | 'invoice' | 'spam_suspicious';
}

export interface FeedbackEntry {
  user_id: string;
  message_id: string;
  sender: string;
  subject: string;
  category: string;
  liked: number;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  snippet: string;
  payload: {
    headers: Array<{ name: string; value: string }>;
    body?: { data?: string };
    parts?: Array<{
      mimeType: string;
      body?: { data?: string; attachmentId?: string };
      parts?: Array<{
        mimeType: string;
        body?: { data?: string };
      }>;
    }>;
  };
}
