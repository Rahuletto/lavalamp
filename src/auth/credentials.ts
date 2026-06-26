import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CREDENTIALS_DIR = join(homedir(), '.config', 'lavalamp');
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, 'credentials');

export interface Credentials {
  accountId: string;
  apiToken: string;
}

export function credentialsPath(): string {
  return CREDENTIALS_FILE;
}

export function loadCredentials(): Credentials | null {
  if (!existsSync(CREDENTIALS_FILE)) {
    return null;
  }

  try {
    const raw = readFileSync(CREDENTIALS_FILE, 'utf8');
    const parsed = JSON.parse(raw);

    if (
      typeof parsed.accountId === 'string' &&
      typeof parsed.apiToken === 'string'
    ) {
      return { accountId: parsed.accountId, apiToken: parsed.apiToken };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveCredentials(creds: Credentials): void {
  if (!existsSync(CREDENTIALS_DIR)) {
    mkdirSync(CREDENTIALS_DIR, { recursive: true });
  }

  writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2));
  chmodSync(CREDENTIALS_FILE, 0o600);
}

export function hasCredentials(): boolean {
  return loadCredentials() !== null;
}

export function clearCredentials(): void {
  if (existsSync(CREDENTIALS_FILE)) {
    unlinkSync(CREDENTIALS_FILE);
  }
}
