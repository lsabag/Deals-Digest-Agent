import { Env, User } from './types';
import { saveFeedback, getFeedbackStats, addMute } from './db';

export async function handleFeedback(request: Request, user: User, env: Env): Promise<Response> {
  const body = await request.json() as {
    message_id: string;
    sender: string;
    subject: string;
    category: string;
    liked: boolean;
  };

  if (!body.message_id || body.liked === undefined) {
    return Response.json({ error: 'message_id and liked are required' }, { status: 400 });
  }

  await saveFeedback(env, {
    user_id: user.id,
    message_id: body.message_id,
    sender: body.sender || '',
    subject: body.subject || '',
    category: body.category || '',
    liked: body.liked ? 1 : 0,
  });

  return Response.json({ ok: true });
}

export async function handlePreferences(user: User, env: Env): Promise<Response> {
  const stats = await getFeedbackStats(env, user.id);
  return Response.json({ stats });
}

export async function handleMute(request: Request, user: User, env: Env): Promise<Response> {
  const body = await request.json() as {
    sender: string;
    mute_type: 'temporary' | 'category' | 'permanent';
    category?: string;
    days?: number;
  };

  if (!body.sender || !body.mute_type) {
    return Response.json({ error: 'sender and mute_type are required' }, { status: 400 });
  }

  let until: string | undefined;
  if (body.mute_type === 'temporary' && body.days) {
    const d = new Date();
    d.setDate(d.getDate() + body.days);
    until = d.toISOString();
  }

  await addMute(env, user.id, body.sender, body.mute_type, body.category, until);

  return Response.json({ ok: true });
}
