import * as path from 'node:path';
import * as fs from 'node:fs';
import { workspaceDataDir } from './paths';

export interface SteeringRule {
  pattern: string;
  instructions: string;
}

export function steeringPath(workspaceRoot: string): string {
  return path.join(workspaceDataDir(workspaceRoot), 'steering.json');
}

export function steerPrompt(prompt: string, workspaceRoot: string): string {
  const configPath = steeringPath(workspaceRoot);
  if (!fs.existsSync(configPath)) {
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
