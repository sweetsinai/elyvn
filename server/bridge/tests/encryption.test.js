'use strict';

jest.mock('../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

/**
 * encryption.test.js
 *
 * The encryption module reads ENCRYPTION_KEY at require-time and derives a
 * 32-byte AES key from its hex representation.  Because the module is cached
 * after the first require, we control key presence via jest.resetModules() and
 * re-require inside each describe block.
 *
 * A valid key must be 64 hex characters (32 bytes when decoded).
 */

// 64 hex chars = 32 bytes — a valid AES-256 key
const VALID_HEX_KEY = 'a'.repeat(64); // 'aaa...aaa' (64 chars)
const WRONG_HEX_KEY = 'b'.repeat(64);

// ─── helpers ────────────────────────────────────────────────────────────────

function loadEncryption(envKey) {
  jest.resetModules();
  if (envKey === undefined) {
    delete process.env.ENCRYPTION_KEY;
  } else {
    process.env.ENCRYPTION_KEY = envKey;
  }
  return require('../utils/encryption');
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe('encrypt / decrypt — key configured', () => {
  let encrypt, decrypt, isEncrypted;

  beforeAll(() => {
    ({ encrypt, decrypt, isEncrypted } = loadEncryption(VALID_HEX_KEY));
  });

  afterAll(() => {
    jest.resetModules();
  });

  it('roundtrip: decrypt(encrypt(plaintext)) === plaintext', () => {
    const plain = 'hello, world!';
    expect(decrypt(encrypt(plain))).toBe(plain);
  });

  it('roundtrip works with unicode and special characters', () => {
    const plain = 'email@example.com | +14155551234 | £€¥ | 日本語';
    expect(decrypt(encrypt(plain))).toBe(plain);
  });

  it('encrypt returns the iv:authTag:ciphertext format', () => {
    const result = encrypt('test');
    expect(result).toMatch(/^[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/);
  });

  it('encrypt returns different ciphertext each call (random IV)', () => {
    const plain = 'same input';
    const c1 = encrypt(plain);
    const c2 = encrypt(plain);
    expect(c1).not.toBe(c2);
  });

  it('isEncrypted returns true for encrypted value', () => {
    expect(isEncrypted(encrypt('something'))).toBe(true);
  });

  it('isEncrypted returns false for plaintext', () => {
    expect(isEncrypted('plain text')).toBe(false);
    expect(isEncrypted('no:colons:here:at:all')).toBe(false);
  });

  it('decrypt returns ciphertext unchanged when auth tag is tampered', () => {
    const ciphertext = encrypt('sensitive data');
    const [iv, tag, data] = ciphertext.split(':');
    // Flip the first byte of the auth tag in base64 space
    const tamperedTag = Buffer.from(tag, 'base64');
    tamperedTag[0] ^= 0xff;
    const tampered = `${iv}:${tamperedTag.toString('base64')}:${data}`;

    // decrypt should return the (bad) input unchanged on failure
    const result = decrypt(tampered);
    expect(result).toBe(tampered);
  });

  it('decrypt returns input unchanged when ciphertext body is tampered', () => {
    const ciphertext = encrypt('another secret');
    const [iv, tag, data] = ciphertext.split(':');
    const tamperedData = Buffer.from(data, 'base64');
    tamperedData[0] ^= 0x01;
    const tampered = `${iv}:${tag}:${tamperedData.toString('base64')}`;

    const result = decrypt(tampered);
    expect(result).toBe(tampered);
  });

  it('large payload roundtrip', () => {
    const plain = 'x'.repeat(100_000);
    expect(decrypt(encrypt(plain))).toBe(plain);
  });

  it('encrypting empty string produces a ciphertext in the iv:tag:data format', () => {
    // An empty plaintext still produces a valid iv:authTag:ciphertext token,
    // but the ciphertext segment itself is empty — the regex requires at least
    // one base64 char in each segment, so isEncrypted returns false and decrypt
    // passes it through unchanged (documented edge-case of the implementation).
    const result = encrypt('');
    expect(typeof result).toBe('string');
    const parts = result.split(':');
    expect(parts).toHaveLength(3);
    // iv and authTag segments are non-empty
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
  });
});

// ─── decrypt with a different key ───────────────────────────────────────────

describe('decrypt with wrong key', () => {
  it('returns the ciphertext unchanged (auth tag mismatch)', () => {
    // Encrypt with key A
    const { encrypt: encA } = loadEncryption(VALID_HEX_KEY);
    const ciphertext = encA('top secret');

    // Decrypt with key B
    const { decrypt: decB } = loadEncryption(WRONG_HEX_KEY);
    const result = decB(ciphertext);

    // Should return input unchanged (auth tag fails → caught → passthrough)
    expect(result).toBe(ciphertext);
  });
});

// ─── passthrough mode — no key ──────────────────────────────────────────────

describe('passthrough mode — ENCRYPTION_KEY not set', () => {
  let encrypt, decrypt, isEncrypted;

  beforeAll(() => {
    ({ encrypt, decrypt, isEncrypted } = loadEncryption(undefined));
  });

  afterAll(() => {
    jest.resetModules();
  });

  it('encrypt returns plaintext unchanged', () => {
    expect(encrypt('hello')).toBe('hello');
  });

  it('decrypt returns input unchanged', () => {
    expect(decrypt('some:data:here')).toBe('some:data:here');
  });

  it('encrypt(null) returns null', () => {
    expect(encrypt(null)).toBeNull();
  });

  it('encrypt(undefined) returns undefined', () => {
    expect(encrypt(undefined)).toBeUndefined();
  });

  it('decrypt(null) returns null', () => {
    expect(decrypt(null)).toBeNull();
  });

  it('decrypt(undefined) returns undefined', () => {
    expect(decrypt(undefined)).toBeUndefined();
  });

  it('isEncrypted returns false for non-string', () => {
    expect(isEncrypted(null)).toBe(false);
    expect(isEncrypted(42)).toBe(false);
  });
});

// ─── passthrough mode — wrong-length key ────────────────────────────────────

describe('passthrough mode — ENCRYPTION_KEY wrong length', () => {
  let encrypt, decrypt;

  beforeAll(() => {
    // Not 64 hex chars → should warn and fall back to passthrough
    ({ encrypt, decrypt } = loadEncryption('tooshort'));
  });

  afterAll(() => {
    jest.resetModules();
  });

  it('encrypt returns plaintext unchanged', () => {
    expect(encrypt('data')).toBe('data');
  });

  it('decrypt returns input unchanged', () => {
    expect(decrypt('iv:tag:data')).toBe('iv:tag:data');
  });
});

// ─── edge cases with key configured ─────────────────────────────────────────

describe('edge cases — key configured', () => {
  let encrypt, decrypt;

  beforeAll(() => {
    ({ encrypt, decrypt } = loadEncryption(VALID_HEX_KEY));
  });

  afterAll(() => {
    jest.resetModules();
  });

  it('encrypt(null) returns null even with key set', () => {
    expect(encrypt(null)).toBeNull();
  });

  it('encrypt(undefined) returns undefined even with key set', () => {
    expect(encrypt(undefined)).toBeUndefined();
  });

  it('decrypt(null) returns null even with key set', () => {
    expect(decrypt(null)).toBeNull();
  });

  it('decrypt value that does not match encrypted format passes through', () => {
    expect(decrypt('not-encrypted')).toBe('not-encrypted');
  });

  it('encrypting a non-string non-null value returns it unchanged', () => {
    const obj = { a: 1 };
    expect(encrypt(obj)).toBe(obj);
  });
});
