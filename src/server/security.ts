import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 256)
    throw new Error('Hasło musi mieć od 12 do 256 znaków.');
  const salt = randomBytes(16).toString('hex');
  const hash = (await derive(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${hash.toString('hex')}`;
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (password.length > 256 || !/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(encoded)) return false;
  const [, salt, expected] = encoded.split(':');
  const actual = (await derive(password, salt, 64)) as Buffer;
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}
export const newToken = () => randomBytes(32).toString('hex');
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const privateKey = (value: string, secret: string) =>
  createHmac('sha256', secret).update(value).digest('hex');
