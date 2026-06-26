export const ACCENT_COLOR = '#FF5E1F';

export const BUILD_MODEL = 'cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash';

export interface ModelCapabilities {
  vision: boolean;
  functionCalling: boolean;
  contextWindow: number;
  provider: string;
}

export const CAPABILITIES: Record<string, ModelCapabilities> = {
  'anthropic/claude-3-5-sonnet-20241022': {
    contextWindow: 200_000,
    functionCalling: true,
    provider: 'anthropic',
    vision: true,
  },
  'anthropic/claude-sonnet-4-20250514': {
    contextWindow: 200_000,
    functionCalling: true,
    provider: 'anthropic',
    vision: true,
  },
  'cloudflare-workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast': {
    contextWindow: 131_072,
    functionCalling: true,
    provider: 'cloudflare-workers-ai',
    vision: false,
  },
  'cloudflare-workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct': {
    contextWindow: 131_072,
    functionCalling: true,
    provider: 'cloudflare-workers-ai',
    vision: true,
  },
  'cloudflare-workers-ai/@cf/moonshotai/kimi-k2.7-code': {
    contextWindow: 262_144,
    functionCalling: true,
    provider: 'cloudflare-workers-ai',
    vision: true,
  },
  'cloudflare-workers-ai/@cf/openai/gpt-oss-120b': {
    contextWindow: 131_072,
    functionCalling: true,
    provider: 'cloudflare-workers-ai',
    vision: false,
  },
  'cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash': {
    contextWindow: 131_072,
    functionCalling: true,
    provider: 'cloudflare-workers-ai',
    vision: false,
  },
  'cloudflare-workers-ai/@cf/zai-org/glm-5.2': {
    contextWindow: 131_072,
    functionCalling: true,
    provider: 'cloudflare-workers-ai',
    vision: false,
  },
  'openai/gpt-4o': {
    contextWindow: 128_000,
    functionCalling: true,
    provider: 'openai',
    vision: true,
  },
  'openai/o3-mini': {
    contextWindow: 200_000,
    functionCalling: true,
    provider: 'openai',
    vision: false,
  },
};

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
  if (override) {
    return override;
  }

  const provider = detectProvider(preferred);
  if (provider === 'anthropic' && !env.ANTHROPIC_API_KEY) {
    console.error(
      `[lavalamp] ANTHROPIC_API_KEY not set, falling back to default model`,
    );
    return BUILD_MODEL;
  }
  if (provider === 'openai' && !env.OPENAI_API_KEY) {
    console.error(
      `[lavalamp] OPENAI_API_KEY not set, falling back to default model`,
    );
    return BUILD_MODEL;
  }

  return preferred;
}
