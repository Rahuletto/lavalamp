#!/usr/bin/env bun
import { loadCredentials } from '../auth/credentials';
import { configPath, resolveConfig, updateConfig } from '../config/user-config';
import { getModelEntry, listModels } from '../config/models';
import { resolveRuntimeRoute, routeSummary } from '../config/runtime-route';

const [command, subcommand, key, ...rest] = process.argv.slice(2);

function printConfig(): void {
  const config = resolveConfig();
  const creds = loadCredentials();
  const route = resolveRuntimeRoute({ config });
  const gatewayLabel = config.gatewayEnabled
    ? `on${config.gatewayId ? ` (${config.gatewayId})` : ' (missing id)'}`
    : config.gatewayId
      ? `off (saved id: ${config.gatewayId})`
      : 'off';
  console.log(`config: ${configPath()}`);
  console.log(`model: ${route.model}`);
  console.log(`gateway: ${gatewayLabel}`);
  console.log(`route: ${routeSummary(route)}`);
  console.log(`usage display: ${config.usageDisplayMode}`);
  console.log(
    `cloudflare: ${creds ? `account ${creds.accountId.slice(0, 8)}...` : 'not logged in'}`,
  );
}

function printModels(): void {
  for (const model of listModels()) {
    const caps = [
      `${Math.round(model.contextWindow / 1000)}k ctx`,
      model.functionCalling ? 'tools' : 'no-tools',
      model.vision ? 'vision' : 'text',
      model.gatewaySupport ? 'gateway' : 'direct',
    ].join(', ');
    console.log(`${model.id}\t${model.displayName}\t${caps}`);
  }
}

function requireValue(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    console.error(`[lavalamp] config set ${name} requires a value`);
    process.exit(1);
  }
  return value;
}

function parseBoolean(value: string): boolean {
  if (['true', '1', 'yes', 'on'].includes(value.toLowerCase())) {
    return true;
  }
  if (['false', '0', 'no', 'off'].includes(value.toLowerCase())) {
    return false;
  }
  console.error('[lavalamp] gateway-enabled must be true or false');
  process.exit(1);
}

function setConfig(): void {
  const value = requireValue(rest.join(' '), key ?? 'value');

  switch (key) {
    case 'model': {
      const entry = getModelEntry(value);
      if (entry === undefined) {
        console.error(`[lavalamp] Unknown model: ${value}`);
        console.error('[lavalamp] Run "lavalamp models" to list known models.');
        process.exit(1);
      }
      updateConfig({ defaultModel: value });
      console.log(`[lavalamp] model set to ${value}`);
      break;
    }
    case 'gateway': {
      updateConfig({
        gatewayEnabled: true,
        gatewayId: value,
        preferredProviderRoute: 'gateway',
      });
      console.log(`[lavalamp] AI Gateway enabled: ${value}`);
      break;
    }
    case 'gateway-enabled': {
      const enabled = parseBoolean(value);
      const current = resolveConfig();
      if (enabled && current.gatewayId.length === 0) {
        console.error(
          '[lavalamp] gateway-enabled true requires a gateway id. Run "lavalamp config set gateway <gateway-id>" first.',
        );
        process.exit(1);
      }
      updateConfig({
        gatewayEnabled: enabled,
        preferredProviderRoute: enabled ? 'gateway' : 'direct',
      });
      console.log(`[lavalamp] AI Gateway ${enabled ? 'enabled' : 'disabled'}`);
      break;
    }
    case 'usage-display': {
      if (value !== 'usage' && value !== 'neurons') {
        console.error('[lavalamp] usage-display must be "usage" or "neurons"');
        process.exit(1);
      }
      updateConfig({ usageDisplayMode: value });
      console.log(`[lavalamp] usage display set to ${value}`);
      break;
    }
    default: {
      console.error(
        'Usage: lavalamp config set {model|gateway|gateway-enabled|usage-display} <value>',
      );
      process.exit(1);
    }
  }
}

if (command === 'models') {
  printModels();
} else if (command === 'config' && subcommand === 'show') {
  printConfig();
} else if (command === 'config' && subcommand === 'set') {
  setConfig();
} else {
  console.error(
    'Usage: lavalamp {models|config show|config set <key> <value>}',
  );
  process.exit(1);
}
