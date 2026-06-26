import { loadCredentials } from '../auth/credentials';
import * as fs from 'fs';

export async function describeImageWithSpectacle(imagePath: string): Promise<string> {
  const creds = loadCredentials();
  if (!creds) {
    return `[Vision Offline: Cloudflare credentials not found]`;
  }

  if (!fs.existsSync(imagePath)) {
    return `[Vision Error: Image file not found at ${imagePath}]`;
  }

  try {
    const buffer = fs.readFileSync(imagePath);
    const imageArray = Array.from(buffer);

    const url = `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/ai/v1/run/@cf/meta/llama-3.2-11b-vision-instruct`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${creds.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: 'Describe this screenshot/image in detail. List all user interface elements, labels, buttons, console output, syntax errors, or text exactly as they appear.',
        image: imageArray,
      }),
    });

    if (!response.ok) {
      throw new Error(`Cloudflare Vision API error: ${response.statusText}`);
    }

    const result = await response.json() as any;
    if (!result.success) {
      throw new Error(`Cloudflare Vision failed: ${JSON.stringify(result.errors)}`);
    }

    return result.result.response || '[No description returned from vision model]';
  } catch (err: any) {
    return `[Vision Processing Error: ${err.message}]`;
  }
}
