import { db, users, sessions, accounts, verifications, apiKeys, passkeys } from '@sigmagit/db';
import { getApiUrl, getWebUrl, getTrustedOrigins, config } from './config';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { sendEmail, sendPasswordResetEmail } from './email';
import { passkey } from '@better-auth/passkey';
import { apiKey, haveIBeenPwned } from 'better-auth/plugins';
import { APIError } from 'better-auth/api';
import { expo } from '@better-auth/expo';
import { betterAuth } from 'better-auth';
import { getRedisSession } from './redis';

function getCookieDomain(): string | undefined {
  try {
    const webUrl = getWebUrl();
    const hostname = new URL(webUrl).hostname;

    const parts = hostname.split('.');
    if (parts.length >= 2) {
      const rootDomain = `.${parts.slice(-2).join('.')}`;

      return rootDomain;
    }

    return undefined;
  } catch (error) {
    console.error(`[API] Error getting cookie domain:`, error);
    return undefined;
  }
}

const BLOCKED_EMAIL_DOMAINS = [
  'tempmail.com',
  'temp-mail.org',
  'guerrillamail.com',
  'guerrillamail.org',
  '10minutemail.com',
  'mailinator.com',
  'throwaway.email',
  'fakeinbox.com',
  'trashmail.com',
  'maildrop.cc',
  'yopmail.com',
  'disposablemail.com',
  'getnada.com',
  'mohmal.com',
  'sharklasers.com',
  'spam4.me',
  'grr.la',
  'dispostable.com',
  'mailnesia.com',
  'spamgourmet.com',
];

const ALLOWED_EMAIL_DOMAINS = [
  // Gmail
  'gmail.com',
  // Hotmail/Outlook/Live
  'hotmail.com',
  'hotmail.co.uk',
  'hotmail.fr',
  'hotmail.de',
  'hotmail.it',
  'hotmail.es',
  'hotmail.nl',
  'hotmail.be',
  'hotmail.ca',
  'hotmail.com.au',
  'outlook.com',
  'outlook.co.uk',
  'outlook.fr',
  'outlook.de',
  'outlook.it',
  'outlook.es',
  'outlook.nl',
  'outlook.be',
  'outlook.ca',
  'outlook.com.au',
  'live.com',
  'live.co.uk',
  'live.fr',
  'live.de',
  'live.it',
  'live.es',
  'live.nl',
  'live.be',
  'live.ca',
  'live.com.au',
  // Yahoo
  'yahoo.com',
  'yahoo.co.uk',
  'yahoo.fr',
  'yahoo.de',
  'yahoo.it',
  'yahoo.es',
  'yahoo.nl',
  'yahoo.be',
  'yahoo.ca',
  'yahoo.com.au',
  'yahoo.co.in',
  // iCloud/Apple
  'icloud.com',
  'me.com',
  'mac.com',
];

const BANNED_USERNAME_WORDS = [
  // Common swear words
  'fuck', 'shit', 'ass', 'bitch', 'damn', 'hell', 'crap', 'piss',
  'dick', 'cock', 'pussy', 'whore', 'slut', 'bastard', 'cunt',
  'bollocks', 'bugger', 'arse', 'bloody', 'frig', 'effing',
  // Antisemitic terms
  'kike', 'hebe', 'yid', 'hooknose', 'sheeny', 'oven', 'holohoax',
  'gas', 'hitler', 'nazi', 'thirdreich', 'ww2', 'holocaust',
  'reich', 'aryan', 'goebbels', 'mengele', 'auschwitz',
  // Other hate speech
  'nigger', 'nigga', 'faggot', 'dyke', 'tranny', 'retard', 'spic',
  'wetback', 'chink', 'gook', 'kaffir', 'cracker', 'honky',
  'darkie', 'redskin', 'squaw', 'paki', 'wop', 'kraut', 'jap',
  // Common evasions (leetspeak/variations) - basic
  'fuk', 'fck', 'sh1t', 'b1tch', 'a$$', 'a55', 'd1ck', 'c0ck',
  'p*ssy', 'f4g', 'n1g', 'k1ke', 'h8', 'h8t', 'n4zi',
];

const GENERIC_SPAM_USERNAMES = [
  // Common spam patterns
  'test', 'testing', 'abc', 'abcd', 'xyz', '123', '1234', 'user',
  'demo', 'example', 'sample', 'temp', 'temporary', 'null', 'undefined',
  'admin', 'administrator', 'moderator', 'staff', 'support', 'help',
  'changeme', 'replace', 'delete', 'remove', 'spam', 'bot',
  // Common throwaway
  'guest', 'anonymous', 'noone', 'nobody', 'someone', 'anyone',
  'username', 'password', 'email', 'address', 'phone', 'number',
  // Single/short generic
  'a', 'b', 'c', 'x', 'y', 'z', 'i', 'me', 'you', 'he', 'she', 'it',
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'done', 'have', 'has', 'had', 'having',
  'will', 'would', 'could', 'should', 'may', 'might', 'shall', 'can',
  // Common sequences
  'qwerty', 'asdfgh', 'zxcvbn', 'qazwsx', 'abcd', 'wxyz',
];

const BANNED_PATTERNS = [
  // Common evasion patterns with separators
  /f[\*\.\-\_\\\/\|\s]?u[\*\.\-\_\\\/\|\s]?c[\*\.\-\_\\\/\|\s]?k/i,
  /s[\*\.\-\_\\\/\|\s]?h[\*\.\-\_\\\/\|\s]?i[\*\.\-\_\\\/\|\s]?t/i,
  /b[\*\.\-\_\\\/\|\s]?i[\*\.\-\_\\\/\|\s]?t[\*\.\-\_\\\/\|\s]?c[\*\.\-\_\\\/\|\s]?h/i,
  /d[\*\.\-\_\\\/\|\s]?i[\*\.\-\_\\\/\|\s]?c[\*\.\-\_\\\/\|\s]?k/i,
  /c[\*\.\-\_\\\/\|\s]?o[\*\.\-\_\\\/\|\s]?c[\*\.\-\_\\\/\|\s]?k/i,
  /p[\*\.\-\_\\\/\|\s]?u[\*\.\-\_\\\/\|\s]?s[\*\.\-\_\\\/\|\s]?s[\*\.\-\_\\\/\|\s]?y/i,
  /w[\*\.\-\_\\\/\|\s]?h[\*\.\-\_\\\/\|\s]?o[\*\.\-\_\\\/\|\s]?r[\*\.\-\_\\\/\|\s]?e/i,
  /s[\*\.\-\_\\\/\|\s]?l[\*\.\-\_\\\/\|\s]?u[\*\.\-\_\\\/\|\s]?t/i,
  /b[\*\.\-\_\\\/\|\s]?a[\*\.\-\_\\\/\|\s]?s[\*\.\-\_\\\/\|\s]?t[\*\.\-\_\\\/\|\s]?a[\*\.\-\_\\\/\|\s]?r[\*\.\-\_\\\/\|\s]?d/i,
  /c[\*\.\-\_\\\/\|\s]?u[\*\.\-\_\\\/\|\s]?n[\*\.\-\_\\\/\|\s]?t/i,
  /k[\*\.\-\_\\\/\|\s]?i[\*\.\-\_\\\/\|\s]?k[\*\.\-\_\\\/\|\s]?e/i,
  /n[\*\.\-\_\\\/\|\s]?a[\*\.\-\_\\\/\|\s]?z[\*\.\-\_\\\/\|\s]?i/i,
  /h[\*\.\-\_\\\/\|\s]?i[\*\.\-\_\\\/\|\s]?t[\*\.\-\_\\\/\|\s]?l[\*\.\-\_\\\/\|\s]?e[\*\.\-\_\\\/\|\s]?r/i,
  // Leetspeak patterns
  /f[\*\.\-\_\\\/\|\s]?4[\*\.\-\_\\\/\|\s]?g/i,
  /n[\*\.\-\_\\\/\|\s]?1[\*\.\-\_\\\/\|\s]?g/i,
  /k[\*\.\-\_\\\/\|\s]?1[\*\.\-\_\\\/\|\s]?k[\*\.\-\_\\\/\|\s]?3/i,
  /n[\*\.\-\_\\\/\|\s]?4[\*\.\-\_\\\/\|\s]?z[\*\.\-\_\\\/\|\s]?i/i,
  /h[\*\.\-\_\\\/\|\s]?8/i,
  // Repeated characters (e.g., "aaa", "111", "!!!")
  /^(.)\1{2,}$/,
  // Sequential characters (e.g., "abc", "123", "xyz")
  /(abc|bcd|cde|def|efg|fgh|ghi|hij|ijk|jkl|klm|lmn|mno|nop|opq|pqr|qrs|rst|stu|tuv|uvw|vwx|wxy|xyz)/i,
  /(012|123|234|345|456|567|678|789|890)/,
  // Keyboard walks (common patterns)
  /qwerty|asdfgh|zxcvbn|qazwsx|qweasd|asdfzxc/i,
];

function containsEmoji(str: string): boolean {
  return /\p{Extended_Pictographic}/u.test(str);
}

function containsBannedWords(username: string): boolean {
  const lowerUsername = username.toLowerCase();
  return BANNED_USERNAME_WORDS.some(word => 
    lowerUsername.includes(word.toLowerCase())
  );
}

function containsBannedPattern(username: string): boolean {
  return BANNED_PATTERNS.some(pattern => pattern.test(username));
}

function isGenericUsername(username: string): boolean {
  const lowerUsername = username.toLowerCase();
  
  // Check against list of known generic usernames
  if (GENERIC_SPAM_USERNAMES.includes(lowerUsername)) {
    return true;
  }
  
  // Check for sequential patterns (e.g., "abc", "123") using regex
  const sequentialPattern = /(abc|bcd|cde|def|efg|fgh|ghi|hij|ijk|jkl|klm|lmn|mno|nop|opq|pqr|qrs|rst|stu|tuv|uvw|vwx|wxy|xyz)/i;
  const sequentialNumbers = /(012|123|234|345|456|567|678|789|890)/;
  
  if (sequentialPattern.test(lowerUsername) || sequentialNumbers.test(lowerUsername)) {
    return true;
  }
  
  // Check for repeated characters (e.g., "aaa", "111")
  if (/^(.)\1{2,}$/.test(lowerUsername)) {
    return true;
  }
  
  return false;
}

function isValidUsername(username: string): { valid: boolean; error?: string } {
  if (username.length < 3) {
    return { valid: false, error: 'Username must be at least 3 characters' };
  }

  if (username.length > 39) {
    return { valid: false, error: 'Username must be 39 characters or less' };
  }

  if (containsEmoji(username)) {
    return { valid: false, error: 'Username cannot contain emojis' };
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return {
      valid: false,
      error: 'Username can only contain letters, numbers, hyphens, and underscores',
    };
  }

  if (!/[a-zA-Z0-9]/.test(username)) {
    return {
      valid: false,
      error: 'Username must contain at least one letter or number',
    };
  }

  if (username.startsWith('-') || username.endsWith('-')) {
    return { valid: false, error: 'Username cannot start or end with a hyphen' };
  }

  if (username.includes('--')) {
    return {
      valid: false,
      error: 'Username cannot contain consecutive hyphens',
    };
  }

  // Check for banned words (swear words, hate speech, antisemitic terms)
  if (containsBannedWords(username)) {
    return {
      valid: false,
      error: 'Username contains prohibited content. Please choose a different username.',
    };
  }

  // Check for banned patterns (evasion attempts, leetspeak, etc.)
  if (containsBannedPattern(username)) {
    return {
      valid: false,
      error: 'Username contains prohibited patterns. Please choose a different username.',
    };
  }

  // Check for generic/spammy usernames
  if (isGenericUsername(username)) {
    return {
      valid: false,
      error: 'Username is too generic or commonly used by spammers. Please choose a more unique username.',
    };
  }

  return { valid: true };
}

function isBlockedEmailDomain(email: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return true;
  return BLOCKED_EMAIL_DOMAINS.includes(domain);
}

function isAllowedEmailDomain(email: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  return ALLOWED_EMAIL_DOMAINS.includes(domain);
}

let authInstance: ReturnType<typeof betterAuth> | null = null;
let authInitPromise: Promise<ReturnType<typeof betterAuth>> | null = null;

export const initAuth = async () => {
  if (authInstance) {
    return authInstance;
  }

  if (authInitPromise) {
    return authInitPromise;
  }

  authInitPromise = (async () => {
    const redis = await getRedisSession();
    const apiUrl = getApiUrl();
    const githubEnabled = Boolean(config.github.clientId && config.github.clientSecret);

    authInstance = betterAuth({
      baseURL: apiUrl,
      database: drizzleAdapter(db, {
        provider: 'pg',
        schema: {
          user: users,
          session: sessions,
          account: accounts,
          verification: verifications,
          apikey: apiKeys,
          passkey: passkeys,
        },
      }),
      secondaryStorage: redis
        ? {
            get: async (key) => {
              try {
                return await redis.get(key);
              } catch (err) {
                console.error("[Redis] get error:", err instanceof Error ? err.message : "Unknown error");
                return null;
              }
            },
            set: async (key, value, ttl) => {
              try {
                if (ttl) await redis.set(key, value, { EX: ttl });
                else await redis.set(key, value);
              } catch (err) {
                console.warn("[Redis] set error (session will fall back to DB):", err instanceof Error ? err.message : "Unknown error");
              }
            },
            delete: async (key) => {
              try {
                await redis.del(key);
              } catch (err) {
                console.warn("[Redis] delete error:", err instanceof Error ? err.message : "Unknown error");
              }
            },
          }
        : undefined,
      session: {
        storeSessionInDatabase: true,
      },
      trustedOrigins: getTrustedOrigins(),
      emailAndPassword: {
        enabled: true,
        requireEmailVerification: false,
        sendResetPassword: async ({ user, url, token }, request) => {
          sendPasswordResetEmail(user.email, token, user.name);
        },
      },
      socialProviders: githubEnabled
        ? {
            github: {
              clientId: config.github.clientId as string,
              clientSecret: config.github.clientSecret as string,
              scope: ["read:user", "user:email"],
            },
          }
        : undefined,
      plugins: [
        haveIBeenPwned({
          customPasswordCompromisedMessage: "Please choose a more secure password.",
        }),
        apiKey({
          defaultPrefix: 'sigmagit_',
          rateLimit: {
            enabled: true,
            maxRequests: 1000,
            timeWindow: '1m',
          },
        }),
        expo(),
        passkey({
          rpID: new URL(getWebUrl()).hostname,
          rpName: 'sigmagit',
          origin: getWebUrl(),
          authenticatorSelection: {
            authenticatorAttachment: undefined,
            residentKey: 'preferred',
            userVerification: 'preferred',
          },
        }),
      ],
      user: {
        additionalFields: {
          username: {
            type: 'string',
            required: true,
            input: true,
          },
          role: {
            type: 'string',
            required: false,
            input: false,
            returned: true,
          },
        },
      },
      advanced: {
        disableOriginCheck: true,
        cookiePrefix: config.nodeEnv === 'production' ? 'sigmagit' : 'sigmagit_dev',
        defaultCookieAttributes: {
          domain: getCookieDomain(),
          secure: config.nodeEnv === 'production',
          sameSite: 'lax' as const,
          path: '/',
        },
      },
      databaseHooks: {
        user: {
          create: {
            before: async (user) => {
              if (isBlockedEmailDomain(user.email)) {
                throw new APIError('BAD_REQUEST', {
                  message:
                    'This email domain is blocked. Please use a different email address.',
                });
              }

              if (config.emailDomainRestriction.enabled && !isAllowedEmailDomain(user.email)) {
                throw new APIError('BAD_REQUEST', {
                  message:
                    'Please use an email from a supported provider (Gmail, Hotmail, Outlook, Yahoo, or iCloud).',
                });
              }

              const username = (user as { username?: string }).username;
              if (username) {
                const validation = isValidUsername(username);
                if (!validation.valid) {
                  throw new APIError('BAD_REQUEST', {
                    message: validation.error,
                  });
                }
              }

              return { data: user };
            },
          },
        },
      },
    });

    return authInstance;
  })();

  return authInitPromise;
};

export const getAuth = () => {
  if (!authInstance) {
    throw new Error('Auth not initialized. Call initAuth() first.');
  }
  return authInstance;
};

export async function verifyCredentials(request: Request): Promise<Response> {
  const secret = config.betterAuthSecret;
  if (!secret) {
    console.error('[API] verify-credentials: missing BETTER_AUTH_SECRET');
    return new Response(JSON.stringify({ error: 'Server misconfigured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const provided = request.headers.get('x-internal-auth');
  if (!provided || provided !== secret) {
    console.warn('[API] verify-credentials: invalid internal auth header');
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: { email?: string; password?: string } | null = null;
  try {
    body = (await request.json()) as { email?: string; password?: string };
  } catch {
    body = null;
  }

  const email = body?.email;
  const password = body?.password;
  const safeEmail =
    typeof email === 'string' ? email.replace(/^(.).+(@.+)$/, '$1***$2') : 'unknown';

  if (
    !email ||
    !password ||
    typeof email !== 'string' ||
    typeof password !== 'string' ||
    !email.includes('@')
  ) {
    console.warn('[API] verify-credentials: invalid body', { email: safeEmail });
    return new Response(JSON.stringify({ error: 'Invalid credentials' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const auth = getAuth();
  let user: any = null;
  try {
    const result: any = await auth.api.signInEmail({
      body: {
        email,
        password,
        rememberMe: false,
      },
      headers: request.headers,
    });
    user = result?.user ?? result?.session?.user ?? null;
    if (user) {
      console.info(`[API] verify-credentials: sign-in successful`, {
        userId: user.id,
        email: safeEmail,
      });
    } else {
      console.warn(`[API] verify-credentials: sign-in ok but no user`, { email: safeEmail });
    }
  } catch (error) {
    console.warn(`[API] verify-credentials: sign-in failed`, {
      email: safeEmail,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    user = null;
  }

  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(
    JSON.stringify({
      user,
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

export type Session = Awaited<ReturnType<ReturnType<typeof betterAuth>['api']['getSession']>>;
