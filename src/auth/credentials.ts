import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  credentialsPath as resolveCredentialsPath,
  credentialsPathCandidates,
} from '../storage/paths';

export interface Credentials {
  accountId: string;
  apiToken: string;
}

export function credentialsPath(): string {
  return resolveCredentialsPath();
}

export function loadCredentials(): Credentials | null {
  if (process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN) {
    return {
      accountId: process.env.CF_ACCOUNT_ID,
      apiToken: process.env.CF_API_TOKEN,
    };
  }

  for (const candidate of credentialsPathCandidates()) {
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      const raw = readFileSync(candidate, 'utf8');
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
  return null;
}

export function saveCredentials(creds: Credentials): void {
  const file = credentialsPath();
  mkdirSync(dirname(file), { recursive: true });

  writeFileSync(file, JSON.stringify(creds, null, 2));
  chmodSync(file, 0o600);
}

export function hasCredentials(): boolean {
  return loadCredentials() !== null;
}

export function clearCredentials(): void {
  for (const file of credentialsPathCandidates()) {
    if (existsSync(file)) {
      unlinkSync(file);
    }
  }
}
