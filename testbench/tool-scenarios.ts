import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

export type ToolScenario =
  | {
      action: 'create' | 'edit';
      path: string;
      content: string;
    }
  | {
      action: 'delete';
      path: string;
    };

export interface ToolScenarioResult {
  action: ToolScenario['action'];
  ok: true;
  path: string;
}

function resolveInsideWorkspace(workspace: string, filePath: string): string {
  const root = resolve(workspace);
  const target = resolve(root, filePath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`tool scenario path is outside workspace: ${filePath}`);
  }
  return target;
}

export async function runToolScenario(
  workspace: string,
  scenario: ToolScenario,
): Promise<ToolScenarioResult> {
  const target = resolveInsideWorkspace(workspace, scenario.path);

  if (scenario.action === 'delete') {
    await rm(target, { force: true, recursive: true });
    return {
      action: scenario.action,
      ok: true,
      path: scenario.path,
    };
  }

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, scenario.content);
  return {
    action: scenario.action,
    ok: true,
    path: scenario.path,
  };
}
