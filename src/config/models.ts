import { resolveConfig } from './user-config';

export const ACCENT_COLOR = '#FF5E1F';

export const BUILD_MODEL = 'cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash';

export interface ModelCapabilities {
  vision: boolean;
  functionCalling: boolean;
  contextWindow: number;
  provider: string;
}

export interface ModelRegistryEntry extends ModelCapabilities {
  id: string;
  displayName: string;
  gatewaySupport: boolean;
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
}

export const MODEL_REGISTRY: Record<string, ModelRegistryEntry> = {
  'anthropic/claude-3-5-sonnet-20241022': {
    contextWindow: 200_000,
    displayName: 'Claude 3.5 Sonnet',
    functionCalling: true,
    gatewaySupport: true,
    id: 'anthropic/claude-3-5-sonnet-20241022',
    provider: 'anthropic',
    vision: true,
  },
  'anthropic/claude-sonnet-4-20250514': {
    contextWindow: 200_000,
    displayName: 'Claude Sonnet 4',
    functionCalling: true,
    gatewaySupport: true,
    id: 'anthropic/claude-sonnet-4-20250514',
    provider: 'anthropic',
    vision: true,
  },
  'cloudflare-workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast': {
    contextWindow: 131_072,
    displayName: 'Llama 3.3 70B Fast',
    functionCalling: true,
    gatewaySupport: true,
    id: 'cloudflare-workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    provider: 'cloudflare-workers-ai',
    vision: false,
  },
  'cloudflare-workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct': {
    contextWindow: 131_072,
    displayName: 'Llama 4 Scout',
    functionCalling: true,
    gatewaySupport: true,
    id: 'cloudflare-workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
    provider: 'cloudflare-workers-ai',
    vision: true,
  },
  'cloudflare-workers-ai/@cf/moonshotai/kimi-k2.7-code': {
    contextWindow: 262_144,
    displayName: 'Kimi K2.7 Code',
    functionCalling: true,
    gatewaySupport: true,
    id: 'cloudflare-workers-ai/@cf/moonshotai/kimi-k2.7-code',
    provider: 'cloudflare-workers-ai',
    vision: true,
  },
  'cloudflare-workers-ai/@cf/openai/gpt-oss-120b': {
    contextWindow: 131_072,
    displayName: 'GPT OSS 120B',
    functionCalling: true,
    gatewaySupport: true,
    id: 'cloudflare-workers-ai/@cf/openai/gpt-oss-120b',
    provider: 'cloudflare-workers-ai',
    vision: false,
  },
  'cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash': {
    contextWindow: 131_072,
    displayName: 'GLM 4.7 Flash',
    functionCalling: true,
    gatewaySupport: true,
    id: 'cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash',
    provider: 'cloudflare-workers-ai',
    vision: false,
  },
  'cloudflare-workers-ai/@cf/zai-org/glm-5.2': {
    contextWindow: 131_072,
    displayName: 'GLM 5.2',
    functionCalling: true,
    gatewaySupport: true,
    id: 'cloudflare-workers-ai/@cf/zai-org/glm-5.2',
    provider: 'cloudflare-workers-ai',
    vision: false,
  },
  'openai/gpt-4o': {
    contextWindow: 128_000,
    displayName: 'GPT-4o',
    functionCalling: true,
    gatewaySupport: true,
    id: 'openai/gpt-4o',
    provider: 'openai',
    vision: true,
  },
  'openai/o3-mini': {
    contextWindow: 200_000,
    displayName: 'o3-mini',
    functionCalling: true,
    gatewaySupport: true,
    id: 'openai/o3-mini',
    provider: 'openai',
    vision: false,
  },
};

export const CAPABILITIES: Record<string, ModelCapabilities> =
  Object.fromEntries(
    Object.entries(MODEL_REGISTRY).map(([id, entry]) => [
      id,
      {
        contextWindow: entry.contextWindow,
        functionCalling: entry.functionCalling,
        provider: entry.provider,
        vision: entry.vision,
      },
    ]),
  );

export function listModels(): ModelRegistryEntry[] {
  return Object.values(MODEL_REGISTRY).toSorted((a, b) =>
    a.id.localeCompare(b.id),
  );
}

export function getModelEntry(model: string): ModelRegistryEntry | undefined {
  return MODEL_REGISTRY[model];
}

export function detectProvider(model: string): string | undefined {
  const slash = model.indexOf('/');
  if (slash === -1) {
    return undefined;
  }
  return model.slice(0, slash);
}

export function resolveModelWithFallback(
  preferred: string,
  env: Record<string, string>,
): string {
  const override = env.LAVALAMP_MODEL;
  if (override !== undefined) {
    return override;
  }

  const configured = resolveConfig().defaultModel;
  if (configured.length > 0) {
    return configured;
  }

  const provider = detectProvider(preferred);
  if (provider === 'anthropic' && env.ANTHROPIC_API_KEY === undefined) {
    console.error(
      `[lavalamp] ANTHROPIC_API_KEY not set, falling back to default model`,
    );
    return BUILD_MODEL;
  }
  if (provider === 'openai' && env.OPENAI_API_KEY === undefined) {
    console.error(
      `[lavalamp] OPENAI_API_KEY not set, falling back to default model`,
    );
    return BUILD_MODEL;
  }

  return preferred;
}
