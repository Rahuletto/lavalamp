import { createHash } from 'node:crypto';
import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join } from 'node:path';

const REPOSITORY = 'Rahuletto/lavalamp';
const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;

interface ReleaseAsset {
  name: string;
  url: string;
}

interface Release {
  assets: ReleaseAsset[];
  tag: string;
  url: string;
}

export interface AvailableUpdate {
  asset: ReleaseAsset;
  checksum: ReleaseAsset;
  releaseUrl: string;
  version: string;
}

function standaloneExecutable(): boolean {
  const runtime = globalThis as typeof globalThis & {
    __LAVALAMP_STANDALONE__?: boolean;
  };
  return runtime.__LAVALAMP_STANDALONE__ ?? false;
}

function versionParts(version: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const next = versionParts(candidate);
  const installed = versionParts(current);
  if (!next || !installed) {
    return false;
  }
  for (let index = 0; index < next.length; index++) {
    const difference = (next[index] ?? 0) - (installed[index] ?? 0);
    if (difference !== 0) {
      return difference > 0;
    }
  }
  return false;
}

export function releaseAssetName(
  platform: NodeJS.Platform,
  architecture: string,
): string | undefined {
  if (architecture !== 'x64' && architecture !== 'arm64') {
    return undefined;
  }
  if (platform === 'linux') {
    return `lavalamp-linux-${architecture}`;
  }
  if (platform === 'darwin') {
    return `lavalamp-darwin-${architecture}`;
  }
  if (platform === 'win32' && architecture === 'x64') {
    return 'lavalamp-windows-x64.exe';
  }
  return undefined;
}

function parseRelease(raw: unknown): Release | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (
    typeof record.tag_name !== 'string' ||
    typeof record.html_url !== 'string' ||
    !Array.isArray(record.assets)
  ) {
    return undefined;
  }
  const assets: ReleaseAsset[] = [];
  for (const value of record.assets) {
    if (typeof value !== 'object' || value === null) {
      continue;
    }
    const asset = value as Record<string, unknown>;
    if (
      typeof asset.name === 'string' &&
      (typeof asset.url === 'string' ||
        typeof asset.browser_download_url === 'string')
    ) {
      assets.push({
        name: asset.name,
        url:
          typeof asset.url === 'string'
            ? asset.url
            : String(asset.browser_download_url),
      });
    }
  }
  return { assets, tag: record.tag_name, url: record.html_url };
}

export function findAvailableUpdate(
  currentVersion: string,
  rawRelease: unknown,
  platform: NodeJS.Platform,
  architecture: string,
): AvailableUpdate | undefined {
  const release = parseRelease(rawRelease);
  const assetName = releaseAssetName(platform, architecture);
  if (
    !release ||
    assetName === undefined ||
    !isNewerVersion(release.tag, currentVersion)
  ) {
    return undefined;
  }
  const asset = release.assets.find((entry) => entry.name === assetName);
  const checksum = release.assets.find((entry) => entry.name === 'SHA256SUMS');
  if (!asset || !checksum) {
    return undefined;
  }
  return {
    asset,
    checksum,
    releaseUrl: release.url,
    version: release.tag.replace(/^v/, ''),
  };
}

export function checksumForAsset(
  checksumFile: string,
  assetName: string,
): string | undefined {
  for (const line of checksumFile.split(/\r?\n/)) {
    const match = /^([a-f\d]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match && match[2] === assetName) {
      return match[1] === undefined ? undefined : match[1].toLowerCase();
    }
  }
  return undefined;
}

function githubHeaders(
  currentVersion: string,
  download = false,
): Record<string, string> {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  return {
    Accept: download
      ? 'application/octet-stream'
      : 'application/vnd.github+json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'User-Agent': `lavalamp/${currentVersion}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function latestUpdate(
  currentVersion: string,
): Promise<AvailableUpdate | undefined> {
  const response = await fetch(LATEST_RELEASE_URL, {
    headers: githubHeaders(currentVersion),
    signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) {
    throw new Error(`GitHub returned HTTP ${response.status}`);
  }
  return findAvailableUpdate(
    currentVersion,
    await response.json(),
    process.platform,
    process.arch,
  );
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of Bun.file(path).stream()) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function cmdQuote(value: string): string {
  return `"${value.replaceAll('%', '%%').replaceAll('"', '""')}"`;
}

async function scheduleWindowsReplacement(
  source: string,
  destination: string,
): Promise<void> {
  const script = join(
    dirname(destination),
    `.lavalamp-update-${process.pid}.ps1`,
  );
  const backup = join(
    dirname(destination),
    `.lavalamp-backup-${process.pid}.exe`,
  );
  writeFileSync(
    script,
    `$ErrorActionPreference = 'Stop'
Wait-Process -Id ${process.pid} -ErrorAction SilentlyContinue
$installed = $false
for ($attempt = 0; $attempt -lt 40; $attempt++) {
  try {
    [System.IO.File]::Replace(${powershellQuote(source)}, ${powershellQuote(destination)}, ${powershellQuote(backup)}, $true)
    $installed = $true
    break
  } catch {
    Start-Sleep -Milliseconds 250
  }
}
if ($installed) {
  Remove-Item -LiteralPath ${powershellQuote(backup)} -Force -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath $PSCommandPath -Force
if (-not $installed) { exit 1 }
`,
  );
  const command = [
    'start "" /b powershell.exe',
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy Bypass',
    `-File ${cmdQuote(script)}`,
  ].join(' ');
  const bootstrap = Bun.spawn(['cmd.exe', '/d', '/s', '/c', command], {
    stderr: 'ignore',
    stdin: 'ignore',
    stdout: 'ignore',
    windowsHide: true,
  });
  const exitCode = await bootstrap.exited;
  if (exitCode !== 0) {
    rmSync(script, { force: true });
    throw new Error('could not start the Windows update helper');
  }
}

async function installUpdate(
  currentVersion: string,
  update: AvailableUpdate,
): Promise<void> {
  const destination = process.execPath;
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const temporary = join(
    dirname(destination),
    `.lavalamp-update-${process.pid}${suffix}`,
  );
  try {
    const [checksumResponse, binaryResponse] = await Promise.all([
      fetch(update.checksum.url, {
        headers: githubHeaders(currentVersion, true),
        signal: AbortSignal.timeout(30_000),
      }),
      fetch(update.asset.url, {
        headers: githubHeaders(currentVersion, true),
        signal: AbortSignal.timeout(120_000),
      }),
    ]);
    if (!checksumResponse.ok || !binaryResponse.ok) {
      throw new Error('release download failed');
    }
    const expected = checksumForAsset(
      await checksumResponse.text(),
      update.asset.name,
    );
    if (expected === undefined) {
      throw new Error('release checksum is missing');
    }
    await Bun.write(temporary, binaryResponse);
    const actual = await fileSha256(temporary);
    if (actual !== expected) {
      throw new Error('release checksum does not match');
    }

    if (process.platform === 'win32') {
      await scheduleWindowsReplacement(temporary, destination);
    } else {
      chmodSync(temporary, 0o755);
      renameSync(temporary, destination);
    }
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

async function applyUpdate(
  currentVersion: string,
  update: AvailableUpdate,
): Promise<boolean> {
  console.error(`[lavalamp] Downloading v${update.version}...`);
  try {
    await installUpdate(currentVersion, update);
    const action =
      process.platform === 'win32'
        ? 'The update will finish after this process exits.'
        : 'The update is installed.';
    console.error(`[lavalamp] ${action} Run lavalamp again.`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[lavalamp] Update failed: ${message}`);
    return false;
  }
}

export async function offerUpdate(currentVersion: string): Promise<boolean> {
  if (!standaloneExecutable()) {
    return false;
  }
  let update: AvailableUpdate | undefined = undefined;
  try {
    update = await latestUpdate(currentVersion);
  } catch {
    return false;
  }
  if (!update) {
    return false;
  }

  console.error(
    `[lavalamp] Update available: v${currentVersion} → v${update.version}`,
  );
  console.error(`[lavalamp] ${update.releaseUrl}`);
  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  const answer = await prompt.question('[lavalamp] Install now? [y/N] ');
  prompt.close();
  if (!/^y(?:es)?$/i.test(answer.trim())) {
    return false;
  }
  return applyUpdate(currentVersion, update);
}

export async function runUpdateCommand(
  currentVersion: string,
): Promise<number> {
  if (!standaloneExecutable()) {
    console.error(
      '[lavalamp] Self-update is only available in release binaries.',
    );
    return 1;
  }
  let update: AvailableUpdate | undefined = undefined;
  try {
    update = await latestUpdate(currentVersion);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[lavalamp] Could not check for updates: ${message}`);
    return 1;
  }
  if (!update) {
    console.error(`[lavalamp] Already up to date (v${currentVersion}).`);
    return 0;
  }
  return (await applyUpdate(currentVersion, update)) ? 0 : 1;
}
