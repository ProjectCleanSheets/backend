import { createSign } from 'node:crypto';

// Enable Banking serves sandbox and production from the same base URL; the
// environment is a property of the registered application (app ID + key pair).
const API_BASE = 'https://api.enablebanking.com';

// Must be registered in the Enable Banking control panel (see CLAUDE.md).
// vercel.json rewrites /auth/bank/callback → /api/auth/bank?action=callback
// Locally, ENABLE_BANKING_REDIRECT_URI points at localhost so the flow round-trips in dev.
const REDIRECT_URI =
  process.env.ENABLE_BANKING_REDIRECT_URI ??
  'https://backend-beryl-phi-32.vercel.app/auth/bank/callback';

// PSD2 consent window requested from the bank. Banks cap this server-side
// (180 days max under the SCA RTS); 90 days is broadly accepted.
const CONSENT_VALIDITY_DAYS = 90;
const JWT_TTL_SECONDS = 3600;

export interface Aspsp {
  name: string;
  country: string;
}

// Enable Banking does not issue refresh tokens: POST /sessions returns a
// session_id that stays valid until access.valid_until, and an expired session
// cannot be refreshed — the user must re-run the consent flow. Callers detect
// expiry via bank_token_expiry and respond with BANK_TOKEN_EXPIRED.
export interface BankSession {
  sessionId: string;
  validUntil: string;
}

// Thrown for non-2xx Enable Banking responses. Carries status, path, and a
// short extracted reason — never the raw body, so logging it cannot leak
// tokens or keys.
export class EnableBankingError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly detail?: string,
  ) {
    super(`Enable Banking ${path} returned ${status}${detail ? ` — ${detail}` : ''}`);
    this.name = 'EnableBankingError';
  }
}

// Pulls a short human-readable reason out of an Enable Banking error body:
// either a top-level `message` string or FastAPI-style `detail` validation
// errors. Truncated; the raw body is never propagated.
async function errorDetail(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) {
      return undefined;
    }
    const { message, detail } = body as { message?: unknown; detail?: unknown };
    if (typeof message === 'string') {
      return message.slice(0, 200);
    }
    if (typeof detail === 'string') {
      return detail.slice(0, 200);
    }
    if (Array.isArray(detail)) {
      const reasons = detail
        .map((item) =>
          item && typeof item === 'object' && typeof (item as { msg?: unknown }).msg === 'string'
            ? (item as { msg: string }).msg
            : null,
        )
        .filter((reason): reason is string => reason !== null);
      if (reasons.length > 0) {
        return reasons.join('; ').slice(0, 200);
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * The sandbox app can only talk to the Mock ASPSP, so ENABLE_BANKING_ENV alone
 * decides the default bank. Production has no default — the caller must name
 * the user's bank. Query params can override the sandbox default too.
 */
export function defaultAspsp(): Aspsp | null {
  return process.env.ENABLE_BANKING_ENV === 'sandbox'
    ? { name: 'Mock ASPSP', country: 'FI' }
    : null;
}

function loadPrivateKey(): string {
  const pem = process.env.ENABLE_BANKING_PRIVATE_KEY;
  if (!pem) {
    throw new Error('ENABLE_BANKING_PRIVATE_KEY is not set');
  }
  // Env vars pasted as a single line often carry literal \n instead of newlines.
  return pem.replace(/\\n/g, '\n');
}

// Every API call is authenticated with a short-lived RS256 JWT signed by the
// application's private key; kid identifies the application.
function signApiJwt(): string {
  const appId = process.env.ENABLE_BANKING_APP_ID;
  if (!appId) {
    throw new Error('ENABLE_BANKING_APP_ID is not set');
  }
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: appId })).toString(
    'base64url',
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'enablebanking.com',
      aud: 'api.enablebanking.com',
      iat: now,
      exp: now + JWT_TTL_SECONDS,
    }),
  ).toString('base64url');
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(loadPrivateKey(), 'base64url');
  return `${header}.${payload}.${signature}`;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${signApiJwt()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new EnableBankingError(response.status, path, await errorDetail(response));
  }
  return (await response.json()) as T;
}

/**
 * Starts a consent flow at the given bank and returns the URL the user must
 * open to authorize (MitID for Danish banks, instant approval at Mock ASPSP).
 * `state` is echoed back on the callback redirect for CSRF validation.
 */
export async function startAuthSession(state: string, aspsp: Aspsp): Promise<string> {
  const validUntil = new Date(Date.now() + CONSENT_VALIDITY_DAYS * 24 * 60 * 60 * 1000);
  const data = await post<{ url: string }>('/auth', {
    access: { valid_until: validUntil.toISOString() },
    aspsp,
    redirect_url: REDIRECT_URI,
    state,
    psu_type: 'personal',
  });
  return data.url;
}

/** Exchanges the callback auth code for a session (see BankSession on refresh). */
export async function exchangeCode(code: string): Promise<BankSession> {
  const data = await post<{ session_id: string; access: { valid_until: string } }>('/sessions', {
    code,
  });
  return { sessionId: data.session_id, validUntil: data.access.valid_until };
}
