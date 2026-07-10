import { loadCredentials } from '../auth/credentials';
import { validateCredentials, login } from '../auth/login';
import { resolveRuntimeRoute } from '../config/runtime-route';
import { BUILD_MODEL } from '../config/models';

export interface PreflightContext {
  outputFormat: 'text' | 'json';
  config: any;
  env: Record<string, string | undefined>;
  model?: string;
}

export async function hasValidCloudflareCredentials(): Promise<boolean> {
  const creds = loadCredentials();
  return creds !== null && (await validateCredentials(creds));
}

function emitHeadlessError(message: string, outputFormat: 'text' | 'json'): void {
  if (outputFormat === 'json') {
    process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  } else {
    console.error(`[lavalamp] Error: ${message}`);
  }
}

export async function preflightInteractiveAuth(ctx: PreflightContext): Promise<void> {
  const route = resolveRuntimeRoute({
    config: ctx.config,
    env: ctx.env,
    model: ctx.model,
    preferredModel: BUILD_MODEL,
  });
  if (!route.requiresCloudflareAuth) {
    return;
  }

  console.error('[lavalamp] Authenticating...');
  if (await hasValidCloudflareCredentials()) {
    console.error('[lavalamp] Authentication complete. Opening TUI...');
    return;
  }

  try {
    await login();
    console.error('[lavalamp] Authentication complete. Opening TUI...');
  } catch (error: unknown) {
    console.error(
      `[lavalamp] Authentication failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

export async function preflightSimpleAuth(
  ctx: PreflightContext,
  quiet: boolean,
): Promise<void> {
  const route = resolveRuntimeRoute({
    config: ctx.config,
    env: ctx.env,
    model: ctx.model,
    preferredModel: BUILD_MODEL,
  });
  if (!route.requiresCloudflareAuth) {
    return;
  }

  if (!quiet) {
    console.error('[lavalamp] Authenticating...');
  }
  if (await hasValidCloudflareCredentials()) {
    return;
  }

  try {
    await login();
  } catch (error: unknown) {
    console.error(
      `[lavalamp] Authentication failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

export async function preflightHeadlessAuth(ctx: PreflightContext): Promise<boolean> {
  const route = resolveRuntimeRoute({
    config: ctx.config,
    env: ctx.env,
    model: ctx.model,
    preferredModel: BUILD_MODEL,
  });
  if (!route.requiresCloudflareAuth) {
    return true;
  }
  if (await hasValidCloudflareCredentials()) {
    return true;
  }
  emitHeadlessError(
    'Cloudflare authentication required. Run `lavalamp login` before using headless mode.',
    ctx.outputFormat,
  );
  return false;
}
