import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// AES-256-GCM: authenticated encryption, so tampered ciphertext fails to decrypt
// instead of silently producing garbage tokens.
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

export function loadEncryptionKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('ENCRYPTION_KEY is not set');
  }
  const key =
    raw.length === 64 && /^[0-9a-f]+$/i.test(raw)
      ? Buffer.from(raw, 'hex')
      : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must decode to 32 bytes (hex or base64)');
  }
  return key;
}

// Format: base64(iv).base64(authTag).base64(ciphertext) — IV is random per value.
export function encryptToken(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, loadEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((part) => part.toString('base64')).join('.');
}

export function decryptToken(encrypted: string): string {
  const [ivPart, tagPart, dataPart] = encrypted.split('.');
  if (!ivPart || !tagPart || !dataPart) {
    throw new Error('Malformed encrypted token');
  }
  const decipher = createDecipheriv(ALGORITHM, loadEncryptionKey(), Buffer.from(ivPart, 'base64'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
