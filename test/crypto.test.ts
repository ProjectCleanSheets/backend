import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { createOAuthState, verifyOAuthState } from '../lib/auth';
import { decryptToken, encryptToken } from '../lib/crypto';

before(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
});

describe('token encryption', () => {
  test('round-trips, with a fresh IV each time', () => {
    const a = encryptToken('refresh-token');
    const b = encryptToken('refresh-token');
    assert.notEqual(a, b);
    assert.equal(decryptToken(a), 'refresh-token');
  });

  test('tampered ciphertext does not decrypt', () => {
    const sealed = encryptToken('refresh-token');
    const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA');
    assert.throws(() => decryptToken(tampered));
  });
});

describe('OAuth state', () => {
  test('returns the user it was issued for', () => {
    assert.equal(verifyOAuthState(createOAuthState('user-1')), 'user-1');
  });

  test('a changed payload or signature is refused', () => {
    const [payload, signature] = createOAuthState('user-1').split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'user-2', exp: 9e9 })).toString('base64url');
    assert.equal(verifyOAuthState(`${forged}.${signature}`), null);
    assert.equal(verifyOAuthState(`${payload}.x${signature!.slice(1)}`), null);
    assert.equal(verifyOAuthState('garbage'), null);
  });
});
