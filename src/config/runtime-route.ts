import {
  BUILD_MODEL,
  detectProvider,
  getModelEntry,
  type ModelRegistryEntry,
} from './models';
import {
  resolveConfig,
  type LavalampConfig,
  type ProviderRoute,
} from './user-config';

type Env = Record<string, string | undefined>;
type ResolvedConfig = Required<LavalampConfig>;

export interface CloudflareCredentials {
  accountId: string;
  apiToken: string;
}

export interface RuntimeRoute {
  gatewayId: string;
  gatewaySupported: boolean;
  model: string;
  mode: ProviderRoute;
  provider: string | undefined;
  registryEntry: ModelRegistryEntry | undefined;
  requiresCloudflareAuth: boolean;
  usesGateway: boolean;
}

export interface ProviderRegistration {
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  provider: string;
}

const GATEWAY_PROVIDERS = new Set([
  'anthropic',
  'cloudflare-workers-ai',
  'openai',
]);

function hasDirectEnv(provider: string | undefined, env: Env): boolean {
  if (provider === 'anthropic') {
    return env.ANTHROPIC_API_KEY !== undefined;
  }
  if (provider === 'openai') {
    return env.OPENAI_API_KEY !== undefined;
  }
  if (provider === 'openrouter') {
    return env.OPENROUTER_API_KEY !== undefined;
  }
  return false;
}

export function getGatewayBaseUrl(
  accountId: string,
  gatewayId: string,
  provider: string,
): string {
  return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/${provider}`;
}

export function resolveSelectedModel(
  preferred: string | undefined,
  env: Env = process.env,
  config: ResolvedConfig = resolveConfig(),
): string {
  return (
    env.LAVALAMP_MODEL ??
    (config.defaultModel.length > 0 ? config.defaultModel : undefined) ??
    preferred ??
    BUILD_MODEL
  );
}

export function resolveRuntimeRoute(
  options: {
    config?: ResolvedConfig;
    env?: Env;
    model?: string;
    preferredModel?: string;
  } = {},
): RuntimeRoute {
  const env = options.env ?? process.env;
  const config = options.config ?? resolveConfig();
  const model =
    options.model ?? resolveSelectedModel(options.preferredModel, env, config);
  const registryEntry = getModelEntry(model);
  const provider = registryEntry?.provider ?? detectProvider(model);
  const gatewaySupported =
    provider !== undefined &&
    GATEWAY_PROVIDERS.has(provider) &&
    (registryEntry?.gatewaySupport ?? true);
  const gatewayConfigured =
    config.gatewayEnabled && config.gatewayId.length > 0;
  const usesWorkersGateway =
    provider === 'cloudflare-workers-ai' &&
    gatewayConfigured &&
    gatewaySupported;
  const usesProviderGateway =
    provider !== undefined &&
    provider !== 'cloudflare-workers-ai' &&
    gatewayConfigured &&
    gatewaySupported &&
    config.preferredProviderRoute === 'gateway' &&
    !hasDirectEnv(provider, env);
  const usesGateway = usesWorkersGateway || usesProviderGateway;

  return {
    gatewayId: usesGateway ? config.gatewayId : '',
    gatewaySupported,
    mode: usesGateway ? 'gateway' : 'direct',
    model,
    provider,
    registryEntry,
    requiresCloudflareAuth: provider === 'cloudflare-workers-ai' || usesGateway,
    usesGateway,
  };
}

export function providerRegistrationsFor(
  env: Env,
  creds: CloudflareCredentials | null,
  config: ResolvedConfig = resolveConfig(),
): ProviderRegistration[] {
  const registrations: ProviderRegistration[] = [];

  if (creds !== null) {
    const gatewayHeaders =
      config.gatewayEnabled && config.gatewayId.length > 0
        ? { 'cf-aig-gateway-id': config.gatewayId }
        : undefined;
    registrations.push({
      apiKey: creds.apiToken,
      baseUrl: `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/ai/v1`,
      headers: gatewayHeaders,
      provider: 'cloudflare-workers-ai',
    });

    const gatewayRoute =
      config.gatewayEnabled &&
      config.gatewayId.length > 0 &&
      config.preferredProviderRoute === 'gateway';
    if (gatewayRoute && env.OPENAI_API_KEY === undefined) {
      registrations.push({
        apiKey: creds.apiToken,
        baseUrl: getGatewayBaseUrl(creds.accountId, config.gatewayId, 'openai'),
        provider: 'openai',
      });
    }
    if (gatewayRoute && env.ANTHROPIC_API_KEY === undefined) {
      registrations.push({
        apiKey: creds.apiToken,
        baseUrl: getGatewayBaseUrl(
          creds.accountId,
          config.gatewayId,
          'anthropic',
        ),
        provider: 'anthropic',
      });
    }
  }

  if (env.ANTHROPIC_API_KEY !== undefined) {
    registrations.push({
      apiKey: env.ANTHROPIC_API_KEY,
      provider: 'anthropic',
    });
  }
  if (env.OPENAI_API_KEY !== undefined) {
    registrations.push({ apiKey: env.OPENAI_API_KEY, provider: 'openai' });
  }
  if (env.OPENROUTER_API_KEY !== undefined) {
    registrations.push({
      apiKey: env.OPENROUTER_API_KEY,
      baseUrl: 'https://openrouter.ai/api/v1',
      provider: 'openrouter',
    });
  }

  return registrations;
}

export function routeSummary(route: RuntimeRoute): string {
  const provider = route.provider ?? 'unknown';
  if (!route.usesGateway) {
    return `${provider} direct`;
  }
  return `${provider} gateway (${route.gatewayId})`;
}
