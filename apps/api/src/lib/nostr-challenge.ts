import { getRedis } from '../redis';

const CHALLENGE_TTL_SEC = 300;
const CHALLENGE_PREFIX = 'nostr:challenge:';

export async function createNostrChallenge(): Promise<string> {
  const challenge = crypto.randomUUID();
  const redis = await getRedis();
  if (redis) {
    await redis.set(`${CHALLENGE_PREFIX}${challenge}`, '1', { EX: CHALLENGE_TTL_SEC });
  }
  return challenge;
}

export async function consumeNostrChallenge(challenge: string): Promise<boolean> {
  const redis = await getRedis();
  if (!redis) {
    console.warn('[Nostr] Redis unavailable — challenge validation skipped');
    return false;
  }
  const key = `${CHALLENGE_PREFIX}${challenge}`;
  const deleted = await redis.del(key);
  return deleted > 0;
}
