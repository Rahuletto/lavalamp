import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  configPath as resolveConfigPath,
  configPathCandidates,
} from '../storage/paths';

export type ProviderRoute = 'direct' | 'gateway';
export type UsageDisplayMode = 'usage' | 'neurons';

export interface LavalampConfig {
  defaultModel?: string;
  gatewayEnabled?: boolean;
  gatewayId?: string;
  preferredProviderRoute?: ProviderRoute;
  usageDisplayMode?: UsageDisplayMode;
}

export const DEFAULT_CONFIG: Required<LavalampConfig> = {
  defaultModel: '',
  gatewayEnabled: false,
  gatewayId: '',
  preferredProviderRoute: 'direct',
  usageDisplayMode: 'neurons',
};

export function configPath(): string {
  return resolveConfigPath();
}

function normalizeConfig(raw: unknown): LavalampConfig {
  if (typeof raw !== 'object' || raw === null) {
    return {};
  }

  const record = raw as Record<string, unknown>;
  const config: LavalampConfig = {};

  if (typeof record.defaultModel === 'string') {
    config.defaultModel = record.defaultModel;
  }
  if (typeof record.gatewayEnabled === 'boolean') {
    config.gatewayEnabled = record.gatewayEnabled;
  }
  if (typeof record.gatewayId === 'string') {
    config.gatewayId = record.gatewayId;
  }
  if (
    record.preferredProviderRoute === 'direct' ||
    record.preferredProviderRoute === 'gateway'
  ) {
    config.preferredProviderRoute = record.preferredProviderRoute;
  }
  if (
    record.usageDisplayMode === 'usage' ||
    record.usageDisplayMode === 'neurons'
  ) {
    config.usageDisplayMode = record.usageDisplayMode;
  }

  return config;
}

export function loadConfig(): LavalampConfig {
  for (const candidate of configPathCandidates()) {
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      return normalizeConfig(JSON.parse(readFileSync(candidate, 'utf8')));
    } catch {
      return {};
    }
  }
  return {};
}

export function resolveConfig(): Required<LavalampConfig> {
  const loaded = loadConfig();
  return {
    defaultModel: loaded.defaultModel ?? DEFAULT_CONFIG.defaultModel,
    gatewayEnabled: loaded.gatewayEnabled ?? DEFAULT_CONFIG.gatewayEnabled,
    gatewayId: loaded.gatewayId ?? DEFAULT_CONFIG.gatewayId,
    preferredProviderRoute:
      loaded.preferredProviderRoute ?? DEFAULT_CONFIG.preferredProviderRoute,
    usageDisplayMode:
      loaded.usageDisplayMode ?? DEFAULT_CONFIG.usageDisplayMode,
  };
}

export function saveConfig(config: LavalampConfig): void {
  const file = configPath();
  mkdirSync(dirname(file), { recursive: true });
  const normalized = normalizeConfig(config);
  writeFileSync(file, `${JSON.stringify(normalized, null, 2)}\n`);
  chmodSync(file, 0o600);
}

export function updateConfig(
  update: Partial<LavalampConfig>,
): Required<LavalampConfig> {
  const next = { ...loadConfig(), ...update };
  saveConfig(next);
  return resolveConfig();
}
