import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  clearCredentials,
  loadCredentials,
  saveCredentials,
} from './credentials';
import type { Credentials } from './credentials';

const REQUIRED_SCOPES = ['account:read', 'ai:write'];

function wranglerConfigPath(): string {
  const { platform } = process;
  if (platform === 'darwin') {
    return join(
      homedir(),
      'Library',
      'Preferences',
      '.wrangler',
      'config',
      'default.toml',
    );
  }
  return join(homedir(), '.wrangler', 'config', 'default.toml');
}

function parseTomlValue(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readWranglerConfig(): {
  refreshToken: string;
  scopes: string[];
} | null {
  const configPath = wranglerConfigPath();
  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const content = readFileSync(configPath, 'utf8');
    let refreshToken = '';
    let scopes: string[] = [];

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('refresh_token')) {
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          refreshToken = parseTomlValue(trimmed.slice(eqIdx + 1));
        }
      }
      if (trimmed.startsWith('scopes')) {
        const bracketStart = trimmed.indexOf('[');
        const bracketEnd = trimmed.indexOf(']');
        if (bracketStart !== -1 && bracketEnd !== -1) {
          const inner = trimmed.slice(bracketStart + 1, bracketEnd);
          scopes = inner
            .split(',')
            .map((scope) => parseTomlValue(scope.trim()))
            .filter(Boolean);
        }
      }
    }

    if (!refreshToken) {
      return null;
    }
    return { refreshToken, scopes };
  } catch {
    return null;
  }
}

async function readWranglerAuthToken(): Promise<string | null> {
  try {
    const result = await new Promise<{ stdout: string; exitCode: number }>(
      (resolve) => {
        const proc = spawn('bunx', ['wrangler', 'auth', 'token', '--json'], {
          env: Object.assign({}, process.env),
        });
        let stdout = '';
        proc.stdout.on('data', (data: Buffer) => (stdout += data.toString()));
        proc.on('close', (code) => resolve({ exitCode: code ?? 1, stdout }));
        proc.on('error', () => resolve({ exitCode: 1, stdout: '' }));
      },
    );

    if (result.exitCode !== 0) {
      return null;
    }
    const parsed = JSON.parse(result.stdout) as { token?: string };
    return typeof parsed.token === 'string' ? parsed.token : null;
  } catch {
    return null;
  }
}

function hasRequiredScopes(scopes: string[]): boolean {
  return REQUIRED_SCOPES.every((r) => scopes.includes(r));
}

 async function runWranglerLogin(): Promise<boolean> {
  return new Promise((resolve) => {
    console.error(`[lavalamp] Opening browser for Cloudflare login...`);
    console.error(`[lavalamp] Required scopes: ${REQUIRED_SCOPES.join(', ')}`);
    console.error('');

    const args = [
      'wrangler',
      'login',
      '--scopes',
      'account:read',
      '--scopes',
      'ai:write',
    ];
    const proc = spawn('bunx', args, { stdio: 'inherit' });

    proc.on('close', (code) => {
      if (code === 0) {
        console.error(`[lavalamp] Login successful.`);
        resolve(true);
      } else {
        console.error(`[lavalamp] Wrangler login failed (exit code ${code}).`);
        resolve(false);
      }
    });

    proc.on('error', (err) => {
      console.error(`[lavalamp] Could not run wrangler: ${err.message}`);
      resolve(false);
    });
  });
}

 async function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function validateCredentials(
  creds: Credentials,
): Promise<boolean> {
  return validateToken(creds.apiToken, creds.accountId);
}

interface CloudflareApiResponse {
  success: boolean;
  errors: unknown[];
  result: { id: string }[];
}

async function validateToken(
  apiToken: string,
  accountId: string,
): Promise<boolean> {
  try {
    const resp = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search`,
      {
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
      },
    );
    const data = (await resp.json()) as CloudflareApiResponse;
    if (data.success) {
      return true;
    }
    const resp2 = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}`,
      {
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
      },
    );
    const data2 = (await resp2.json()) as CloudflareApiResponse;
    return data2.success;
  } catch {
    return false;
  }
}

async function fetchAccountIdFromToken(
  apiToken: string,
): Promise<string | null> {
  try {
    const resp = await fetch('https://api.cloudflare.com/client/v4/accounts', {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    });
    const data = (await resp.json()) as CloudflareApiResponse;
    if (data.success && data.result.length > 0) {
      return data.result[0].id;
    }
    return null;
  } catch {
    return null;
  }
}

async function resolveAccountId(oauthToken: string): Promise<string | null> {
  const direct = await fetchAccountIdFromToken(oauthToken);
  if (direct !== null) {
    return direct;
  }

  try {
    const result = await new Promise<{ stdout: string; exitCode: number }>(
      (resolve) => {
        const proc = spawn('bunx', ['wrangler', 'whoami'], {
          env: Object.assign({}, process.env),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        proc.on('close', (code) => resolve({ exitCode: code ?? 1, stdout }));
      },
    );

    if (result.exitCode === 0) {
      const match = /Account ID:\s*([a-f0-9]+)/i.exec(result.stdout);
      if (match) {
        return match[1];
      }
    }
  } catch {}

  return null;
}

async function tryWranglerToken(): Promise<Credentials | null> {
  const wrangler = readWranglerConfig();
  if (!wrangler) {
    return null;
  }

  console.error(`[lavalamp] Found Wrangler login.`);

  const oauthToken = await readWranglerAuthToken();
  if (oauthToken === null) {
    console.error(`[lavalamp] Could not read refreshed Wrangler auth token.`);
    return null;
  }

  const accountId = await resolveAccountId(oauthToken);
  if (accountId === null) {
    console.error(`[lavalamp] Could not resolve account ID from token.`);
    return null;
  }

  console.error(`[lavalamp] Account ID: ${accountId.slice(0, 8)}...`);

  const valid = await validateToken(oauthToken, accountId);
  if (!valid) {
    console.error(`[lavalamp] Token validation failed.`);
    return null;
  }

  return { accountId, apiToken: oauthToken };
}

export async function login(): Promise<Credentials> {
  const existing = loadCredentials();
  if (existing) {
    const valid = await validateCredentials(existing);
    if (valid) {
      console.error(
        `[lavalamp] Already logged in (account ${existing.accountId.slice(0, 8)}...)`,
      );
      return existing;
    }
    console.error(
      `[lavalamp] Existing credentials are invalid. Re-authenticating...`,
    );
    clearCredentials();
  }

  console.error(`[lavalamp] Setting up Cloudflare access...`);
  console.error('');

  const wrangler = readWranglerConfig();
  if (wrangler && hasRequiredScopes(wrangler.scopes)) {
    console.error(`[lavalamp] Using existing Wrangler token...`);
    const creds = await tryWranglerToken();
    if (creds) {
      saveCredentials(creds);
      console.error(`[lavalamp] Saved to ~/.config/lavalamp/credentials`);
      return creds;
    }
    console.error(
      `[lavalamp] Could not use existing token, re-authenticating...`,
    );
    console.error('');
  } else if (wrangler && !hasRequiredScopes(wrangler.scopes)) {
    console.error(`[lavalamp] Wrangler token missing required scopes.`);
    console.error(`[lavalamp] Re-authenticating with correct scopes...`);
  } else {
    console.error(`[lavalamp] No Wrangler token found. Authenticating...`);
  }

  const loginOk = await runWranglerLogin();
  if (loginOk) {
    const creds = await tryWranglerToken();
    if (creds) {
      saveCredentials(creds);
      console.error(`[lavalamp] Saved to ~/.config/lavalamp/credentials`);
      return creds;
    }
  }

  console.error('');
  console.error(
    `[lavalamp] Auto-login didn't work. Paste your Cloudflare API token:`,
  );
  console.error(
    `[lavalamp] (Create one at https://dash.cloudflare.com/profile/api-tokens`,
  );
  console.error(`[lavalamp]  with "Workers AI: Edit" permissions)`);
  console.error('');
  const apiToken = await prompt('  Token: ');
  if (!apiToken) {
    throw new Error('No token provided');
  }

  console.error('');
  console.error(`[lavalamp] Paste your Cloudflare Account ID:`);
  console.error(
    `[lavalamp] (Find at https://dash.cloudflare.com → right sidebar)`,
  );
  console.error('');
  const accountId = await prompt('  Account ID: ');
  if (!accountId) {
    throw new Error('No account ID provided');
  }

  console.error('');
  console.error(`[lavalamp] Validating...`);

  const valid = await validateToken(apiToken, accountId);
  if (!valid) {
    throw new Error(
      'Invalid credentials — token + account ID combination failed validation',
    );
  }

  const creds = { accountId, apiToken };
  saveCredentials(creds);
  console.error(`[lavalamp] Saved to ~/.config/lavalamp/credentials`);
  return creds;
}
