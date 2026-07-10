import { registerProvider } from '@flue/runtime';
import { loadCredentials } from '../auth/credentials';
import { providerRegistrationsFor } from './runtime-route';

let registered = false;

/**
 * Register model providers once per process.
 * Safe to call from build and every expert entrypoint.
 */
export function ensureProviders(
  env: Record<string, string | undefined> = process.env,
): void {
  if (registered) {
    return;
  }
  registered = true;

  let creds: ReturnType<typeof loadCredentials> = null;
  try {
    creds = loadCredentials();
  } catch {
    /* credentials unavailable */
  }

  for (const registration of providerRegistrationsFor(
    env as Record<string, string>,
    creds,
  )) {
    const options: {
      apiKey: string;
      baseUrl?: string;
      headers?: Record<string, string>;
    } = {
      apiKey: registration.apiKey,
    };
    if (registration.baseUrl !== undefined) {
      options.baseUrl = registration.baseUrl;
    }
    if (registration.headers !== undefined) {
      options.headers = registration.headers;
    }
    registerProvider(registration.provider, options);
  }
}
