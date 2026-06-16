export const ACCENT_COLOR = '#FF5E1F';

export const BUILD_MODEL = 'cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash';

export interface ModelCapabilities {
  vision: boolean;
  functionCalling: boolean;
  contextWindow: number;
  provider: string;
}

export const CAPABILITIES: Record<string, ModelCapabilities> = {
  'cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash': {
    vision: false, functionCalling: true, contextWindow: 131_072, provider: 'cloudflare-workers-ai',
  },
  'cloudflare-workers-ai/@cf/moonshotai/kimi-k2.7-code': {
    vision: true, functionCalling: true, contextWindow: 262_144, provider: 'cloudflare-workers-ai',
  },
  'cloudflare-workers-ai/@cf/zai-org/glm-5.2': {
    vision: false, functionCalling: true, contextWindow: 131_072, provider: 'cloudflare-workers-ai',
  },
  'cloudflare-workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast': {
    vision: false, functionCalling: true, contextWindow: 131_072, provider: 'cloudflare-workers-ai',
  },
  'cloudflare-workers-ai/@cf/openai/gpt-oss-120b': {
    vision: false, functionCalling: true, contextWindow: 131_072, provider: 'cloudflare-workers-ai',
  },
  'cloudflare-workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct': {
    vision: true, functionCalling: true, contextWindow: 131_072, provider: 'cloudflare-workers-ai',
  },
  'anthropic/claude-sonnet-4-20250514': {
    vision: true, functionCalling: true, contextWindow: 200_000, provider: 'anthropic',
  },
  'anthropic/claude-3-5-sonnet-20241022': {
    vision: true, functionCalling: true, contextWindow: 200_000, provider: 'anthropic',
  },
  'openai/gpt-4o': {
    vision: true, functionCalling: true, contextWindow: 128_000, provider: 'openai',
  },
  'openai/o3-mini': {
    vision: false, functionCalling: true, contextWindow: 200_000, provider: 'openai',
  },
};

export function detectProvider(model: string): string | undefined {
  const slash = model.indexOf('/');
  if (slash === -1) return undefined;
  return model.slice(0, slash);
}

export function resolveModelWithFallback(
  preferred: string,
  env: Record<string, string>,
): string {
  const override = env.LAVALAMP_MODEL;
  if (override) return override;

  const provider = detectProvider(preferred);
  if (provider === 'anthropic' && !env.ANTHROPIC_API_KEY) {
    console.error(`[lavalamp] ANTHROPIC_API_KEY not set, falling back to default model`);
    return BUILD_MODEL;
  }
  if (provider === 'openai' && !env.OPENAI_API_KEY) {
    console.error(`[lavalamp] OPENAI_API_KEY not set, falling back to default model`);
    return BUILD_MODEL;
  }

  return preferred;
}
