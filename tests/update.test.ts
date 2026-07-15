import { describe, expect, test } from 'bun:test';
import {
  checksumForAsset,
  findAvailableUpdate,
  isNewerVersion,
  releaseAssetName,
} from '../src/run/update';

const release = {
  assets: [
    {
      browser_download_url: 'https://example.com/lavalamp-linux-x64',
      name: 'lavalamp-linux-x64',
      url: 'https://api.example.com/lavalamp-linux-x64',
    },
    {
      browser_download_url: 'https://example.com/lavalamp-windows-x64.exe',
      name: 'lavalamp-windows-x64.exe',
    },
    {
      browser_download_url: 'https://example.com/SHA256SUMS',
      name: 'SHA256SUMS',
      url: 'https://api.example.com/SHA256SUMS',
    },
  ],
  html_url: 'https://github.com/Rahuletto/lavalamp/releases/tag/v0.2.0',
  tag_name: 'v0.2.0',
};

describe('release updater', () => {
  test('compares stable semantic versions', () => {
    expect(isNewerVersion('v0.2.0', '0.1.9')).toBe(true);
    expect(isNewerVersion('v0.1.9', '0.2.0')).toBe(false);
    expect(isNewerVersion('not-a-version', '0.1.0')).toBe(false);
  });

  test('maps release assets for supported platforms', () => {
    expect(releaseAssetName('linux', 'arm64')).toBe('lavalamp-linux-arm64');
    expect(releaseAssetName('darwin', 'x64')).toBe('lavalamp-darwin-x64');
    expect(releaseAssetName('win32', 'x64')).toBe('lavalamp-windows-x64.exe');
    expect(releaseAssetName('win32', 'arm64')).toBeUndefined();
  });

  test('selects a newer release only when its binary and checksum exist', () => {
    expect(findAvailableUpdate('0.1.2', release, 'linux', 'x64')).toEqual({
      asset: {
        name: 'lavalamp-linux-x64',
        url: 'https://api.example.com/lavalamp-linux-x64',
      },
      checksum: {
        name: 'SHA256SUMS',
        url: 'https://api.example.com/SHA256SUMS',
      },
      releaseUrl: 'https://github.com/Rahuletto/lavalamp/releases/tag/v0.2.0',
      version: '0.2.0',
    });
    expect(
      findAvailableUpdate('0.2.0', release, 'linux', 'x64'),
    ).toBeUndefined();
    expect(
      findAvailableUpdate('0.1.2', release, 'darwin', 'arm64'),
    ).toBeUndefined();
  });

  test('reads the checksum for the exact platform asset', () => {
    const digest = 'a'.repeat(64);
    expect(
      checksumForAsset(
        `${'b'.repeat(64)}  lavalamp-linux-arm64\n${digest}  lavalamp-linux-x64\n`,
        'lavalamp-linux-x64',
      ),
    ).toBe(digest);
    expect(checksumForAsset(`${digest}  other`, 'missing')).toBeUndefined();
  });
});
