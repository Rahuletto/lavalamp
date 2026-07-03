#!/usr/bin/env bun
import { login } from '../auth/login';
import { loadCredentials, clearCredentials } from '../auth/credentials';

const command = process.argv[2];

async function main() {
  switch (command) {
    case 'login': {
      try {
        const creds = await login();
        console.log(
          `[lavalamp] Logged in as account ${creds.accountId.slice(0, 8)}...`,
        );
      } catch (error: unknown) {
        console.error(`[lavalamp] Login failed: ${(error as Error).message}`);
        process.exit(1);
      }
      break;
    }

    case 'logout': {
      clearCredentials();
      console.log('[lavalamp] Credentials removed.');
      break;
    }

    case 'status': {
      const creds = loadCredentials();
      if (creds) {
        console.log(
          `[lavalamp] Logged in as account ${creds.accountId.slice(0, 8)}...`,
        );
      } else {
        console.log(
          '[lavalamp] Not logged in. Run "lavalamp login" to authenticate.',
        );
      }
      break;
    }

    case undefined: {
      console.error('Usage: lavalamp {login|logout|status}');
      process.exit(1);
    }
    default: {
      console.error('Usage: lavalamp {login|logout|status}');
      process.exit(1);
    }
  }
}

await main();
