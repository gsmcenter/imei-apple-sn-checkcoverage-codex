import { hashPassword } from '../src/server/security.js';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

if (!process.stdin.isTTY) {
  let password = '';
  for await (const chunk of process.stdin) password += chunk;
  console.log(`ADMIN_PASSWORD_HASH=${await hashPassword(password.trimEnd())}`);
} else {
  console.log('Generator konfiguracji. Hasło nie będzie widoczne podczas wpisywania.');
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const mutable = readline as unknown as { _writeToOutput: (text: string) => void };
  mutable._writeToOutput = () => {};
  process.stdout.write('Hasło (minimum 12 znaków): ');
  const password = await readline.question('');
  process.stdout.write('\nPowtórz hasło: ');
  const repeated = await readline.question('');
  readline.close();
  process.stdout.write('\n');
  if (password !== repeated) throw new Error('Hasła są różne.');
  console.log(`ADMIN_PASSWORD_HASH=${await hashPassword(password)}`);
  console.log(`SESSION_SECRET=${randomBytes(32).toString('hex')}`);
}
