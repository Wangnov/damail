import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

function subKey(purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', config.masterKey, Buffer.alloc(0), purpose, 32));
}

// 派生标签沿用项目改名（MailHub → DaMail）前的名字：改了会导致已加密保存的邮箱凭证无法解密，不能修改
const encKey = subKey('mailhub:secrets');
const sessionKey = subKey('mailhub:session');

/** AES-256-GCM 加密，输出 base64(iv | tag | ciphertext) */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

export function decryptSecret(payload: string): string {
  const buf = Buffer.from(payload, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', encKey, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** 会话令牌：base64url(json).hmac */
export function signSession(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', sessionKey).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifySession<T>(token: string): T | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', sessionKey).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

export function generateApiKey(): string {
  return `dm_${randomBytes(24).toString('base64url')}`;
}
