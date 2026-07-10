import { loadCredentials } from '../auth/credentials';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';

const SPECTACLE_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
const SPECTACLE_FALLBACK = '@cf/meta/llama-3.2-11b-vision-instruct';

const descriptionCache = new Map<string, string>();

function hashFile(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  return createHash('sha256').update(buffer).digest('hex');
}

export async function describeImageWithSpectacle(
  imagePath: string,
): Promise<string> {
  const creds = loadCredentials();
  if (!creds) {
    return `[Vision Offline: Cloudflare credentials not found]`;
  }
  const { accountId, apiToken } = creds;

  if (!fs.existsSync(imagePath)) {
    return `[Vision Error: Image file not found at ${imagePath}]`;
  }

  // Cache by image hash — avoid re-describing the same screenshot
  const hash = hashFile(imagePath);
  const cached = descriptionCache.get(hash);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const buffer = fs.readFileSync(imagePath);
    const imageArray = [...buffer];

    async function tryModel(model: string): Promise<string> {
      const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/run/${model}`;
      const response = await fetch(url, {
        body: JSON.stringify({
          image: imageArray,
          prompt:
            'Describe this screenshot/image in detail. List all user interface elements, labels, buttons, console output, syntax errors, or text exactly as they appear.',
        }),
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error(`Cloudflare Vision API error: ${response.statusText}`);
      }

      const result = (await response.json()) as {
        success: boolean;
        result: { response?: string };
        errors: unknown[];
      };
      if (!result.success) {
        throw new Error(
          `Cloudflare Vision failed: ${JSON.stringify(result.errors)}`,
        );
      }

      return (
        result.result.response ?? '[No description returned from vision model]'
      );
    }

    let description: string;
    try {
      description = await tryModel(SPECTACLE_MODEL);
    } catch {
      // Fallback to the cheaper 11b vision model if scout fails
      description = await tryModel(SPECTACLE_FALLBACK);
    }

    descriptionCache.set(hash, description);
    return description;
  } catch (error: unknown) {
    return `[Vision Processing Error: ${(error as Error).message}]`;
  }
}
