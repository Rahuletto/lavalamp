import { describe, expect, test } from 'bun:test';
import {
  providerRegistrationsFor,
  resolveRuntimeRoute,
  resolveSelectedModel,
} from '../src/config/runtime-route.ts';
import { BUILD_MODEL } from '../src/config/models.ts';
import type { LavalampConfig } from '../src/config/user-config.ts';

const baseConfig: Required<LavalampConfig> = {
  defaultModel: '',
  gatewayEnabled: false,
  gatewayId: '',
  preferredProviderRoute: 'direct',
  usageDisplayMode: 'neurons',
};

describe('runtime route resolution', () => {
  test('uses env model before config and default', () => {
    expect(
      resolveSelectedModel(
        'openai/gpt-4o',
        {
          LAVALAMP_MODEL: 'anthropic/claude-sonnet-4-20250514',
        },
        {
          ...baseConfig,
          defaultModel: 'cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash',
        },
      ),
    ).toBe('anthropic/claude-sonnet-4-20250514');
  });

  test('uses config model before built-in default', () => {
    expect(
      resolveSelectedModel(
        undefined,
        {},
        {
          ...baseConfig,
          defaultModel: 'openai/gpt-4o',
        },
      ),
    ).toBe('openai/gpt-4o');
  });

  test('defaults Workers AI to direct route without Gateway config', () => {
    const route = resolveRuntimeRoute({
      config: baseConfig,
      env: {},
      preferredModel: BUILD_MODEL,
    });

    expect(route.model).toBe(BUILD_MODEL);
    expect(route.mode).toBe('direct');
    expect(route.provider).toBe('cloudflare-workers-ai');
    expect(route.requiresCloudflareAuth).toBe(true);
    expect(route.usesGateway).toBe(false);
  });

  test('routes Workers AI through AI Gateway when enabled', () => {
    const route = resolveRuntimeRoute({
      config: {
        ...baseConfig,
        gatewayEnabled: true,
        gatewayId: 'default',
      },
      env: {},
      preferredModel: BUILD_MODEL,
    });

    expect(route.mode).toBe('gateway');
    expect(route.gatewayId).toBe('default');
    expect(route.usesGateway).toBe(true);
  });

  test('uses Gateway stored-key route for OpenAI when no direct key exists', () => {
    const route = resolveRuntimeRoute({
      config: {
        ...baseConfig,
        defaultModel: 'openai/gpt-4o',
        gatewayEnabled: true,
        gatewayId: 'team',
        preferredProviderRoute: 'gateway',
      },
      env: {},
    });

    expect(route.mode).toBe('gateway');
    expect(route.provider).toBe('openai');
    expect(route.gatewayId).toBe('team');
  });

  test('prefers direct OpenAI key over Gateway stored-key route', () => {
    const route = resolveRuntimeRoute({
      config: {
        ...baseConfig,
        defaultModel: 'openai/gpt-4o',
        gatewayEnabled: true,
        gatewayId: 'team',
        preferredProviderRoute: 'gateway',
      },
      env: { OPENAI_API_KEY: 'direct' },
    });

    expect(route.mode).toBe('direct');
    expect(route.usesGateway).toBe(false);
  });
});

describe('provider registration resolution', () => {
  test('registers Workers AI and Gateway provider routes from Cloudflare creds', () => {
    const providers = providerRegistrationsFor(
      {},
      { accountId: 'acct', apiToken: 'cf-token' },
      {
        ...baseConfig,
        gatewayEnabled: true,
        gatewayId: 'team',
        preferredProviderRoute: 'gateway',
      },
    );

    expect(providers.map((p) => p.provider)).toEqual([
      'cloudflare-workers-ai',
      'openai',
      'anthropic',
    ]);
    expect(providers[0]?.headers).toEqual({ 'cf-aig-gateway-id': 'team' });
    expect(providers[1]?.baseUrl).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct/team/openai',
    );
  });

  test('direct BYOK providers override Gateway provider registrations', () => {
    const providers = providerRegistrationsFor(
      { OPENAI_API_KEY: 'direct-openai' },
      { accountId: 'acct', apiToken: 'cf-token' },
      {
        ...baseConfig,
        gatewayEnabled: true,
        gatewayId: 'team',
        preferredProviderRoute: 'gateway',
      },
    );

    const openaiProviders = providers.filter((p) => p.provider === 'openai');
    expect(openaiProviders).toHaveLength(1);
    expect(openaiProviders[0]?.apiKey).toBe('direct-openai');
    expect(openaiProviders[0]?.baseUrl).toBeUndefined();
  });
});
