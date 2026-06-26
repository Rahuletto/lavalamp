import * as path from 'node:path';
import * as fs from 'node:fs';

export interface SteeringRule {
  pattern: string;
  instructions: string;
}

export function steerPrompt(prompt: string, workspaceRoot: string): string {
  const configPath = path.join(workspaceRoot, '.lavalamp', 'steering.json');
  if (!fs.existsSync(configPath)) {
    // Write a default empty file if it doesn't exist yet
    try {
      const parent = path.dirname(configPath);
      if (!fs.existsSync(parent)) {
        fs.mkdirSync(parent, { recursive: true });
      }
      fs.writeFileSync(
        configPath,
        JSON.stringify(
          [
            {
              instructions: 'Ensure all tests are written using bun:test.',
              pattern: 'test',
            },
          ],
          null,
          2,
        ),
      );
    } catch {}
    return prompt;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const rules = JSON.parse(raw) as SteeringRule[];
    let injectedInstructions = '';

    for (const rule of rules) {
      const regex = new RegExp(rule.pattern, 'i');
      if (regex.test(prompt)) {
        injectedInstructions += `\n- Rule match (${rule.pattern}): ${rule.instructions}`;
      }
    }

    if (injectedInstructions) {
      return `${prompt}\n\n[STEERING CONTEXT (dynamically injected based on matching rules)]${injectedInstructions}`;
    }
  } catch {}

  return prompt;
}
