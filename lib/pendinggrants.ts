import { randomBytes } from 'node:crypto';
import { getSupabase } from './supabase';

// Shared mechanism for the two-step OAuth connect (tasks 15 & 17). A browser
// OAuth callback cannot be trusted to store credentials directly: the `state`
// only proves who *started* the flow, and anyone can be phished into completing a
// consent against someone else's state (account-linking / authorization-code
// injection). So the callback parks the exchanged credential behind a random,
// short-lived, single-use handle bound to the initiator, and the app finalizes it
// under its own verified auth — the credential can only ever land on the account
// that both initiated the flow and re-authenticated.
//
// Each flow keeps its own table (bank_pending_sessions, google_pending_grants) so
// a table holds only the columns its flow needs (e.g. the bank consent's
// valid_until, which the Google flow has no equivalent of). This module is the
// generalised mechanism — minting and single-use consumption — over any such
// table; both tables share the common columns handle / initiator_user_id /
// expires_at that the mechanism relies on.

// Very short-lived: the app calls finalize the moment the deep link returns.
const HANDLE_TTL_MS = 2 * 60 * 1000;
const HANDLE_BYTES = 32;
// base64url of 32 bytes is 43 chars; a small ceiling keeps the lookup key sane.
export const HANDLE_MAX_LENGTH = 64;

/**
 * Inserts a pending grant behind a fresh random handle. `payload` carries the
 * flow-specific columns — the encrypted credential, plus any extra like a bank
 * consent's `valid_until`. Returns the minted handle, or the DB error message for
 * the caller to log (never surfaced to the client).
 */
export async function mintPendingGrant(
  table: string,
  initiatorUserId: string,
  payload: Record<string, string>,
): Promise<{ handle: string } | { error: string }> {
  const handle = randomBytes(HANDLE_BYTES).toString('base64url');
  const { error } = await getSupabase()
    .from(table)
    .insert({
      handle,
      initiator_user_id: initiatorUserId,
      expires_at: new Date(Date.now() + HANDLE_TTL_MS).toISOString(),
      ...payload,
    });
  if (error) {
    return { error: error.message };
  }
  return { handle };
}

export type ConsumeResult =
  | { ok: true; payload: Record<string, string | null> }
  | { ok: false; reason: 'db_error'; detail: string }
  | { ok: false; reason: 'not_found' | 'expired' | 'wrong_initiator' };

/**
 * Consumes a handle single-use: reads the grant, deletes it up front (so a leaked
 * or replayed handle is already dead even if a later step fails), then enforces
 * that it has not expired and that only its initiator may finalize it. `columns`
 * are the flow-specific columns to return in `payload`; the common columns
 * (initiator_user_id, expires_at) are always selected. Callers map each `reason`
 * to their own HTTP status and message.
 */
export async function consumePendingGrant(
  table: string,
  handle: string,
  callerUserId: string,
  columns: string[],
): Promise<ConsumeResult> {
  const supabase = getSupabase();
  const { data: pending, error } = await supabase
    .from(table)
    .select(['initiator_user_id', 'expires_at', ...columns].join(', '))
    .eq('handle', handle)
    .maybeSingle();
  if (error) {
    return { ok: false, reason: 'db_error', detail: error.message };
  }
  if (!pending) {
    return { ok: false, reason: 'not_found' };
  }

  // Consume before doing anything with it: single-use even if a later check fails.
  await supabase.from(table).delete().eq('handle', handle);

  const row = pending as unknown as Record<string, string | null>;
  if (new Date(row.expires_at as string).getTime() <= Date.now()) {
    return { ok: false, reason: 'expired' };
  }
  // Only the account that initiated the flow may finalize it. Blocks the reverse
  // account-linking direction (a handle delivered to another device attaching a
  // stranger's credential to this caller), independent of app deep-link handling.
  if (row.initiator_user_id !== callerUserId) {
    return { ok: false, reason: 'wrong_initiator' };
  }
  return { ok: true, payload: row };
}
