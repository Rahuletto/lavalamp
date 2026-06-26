import * as v from 'valibot';
import { defineTool } from '@flue/runtime';
import * as path from 'node:path';
import * as fs from 'node:fs';

const loadSkillSchema = v.object({
  name: v.string(),
});

export function createLoadSkillTool(workspaceRoot: string) {
  return defineTool({
    description:
      'Load the instructions/guidance for a specific skill (e.g. deslop, thermonuclear review) from local or global directories.',
    execute: async ({ name }) => {
      const home = process.env.HOME ?? '';
      const dirs = [
        path.join(workspaceRoot, '.agents', 'skills', name),
        path.join(workspaceRoot, '..', '.agents', 'skills', name),
        home ? path.join(home, '.agents', 'skills', name) : '',
      ];

      for (const dir of dirs) {
        if (!dir) continue;
        const skillMd = path.join(dir, 'SKILL.md');
        if (fs.existsSync(skillMd)) {
          const content = fs.readFileSync(skillMd, 'utf8');
          return `Successfully loaded skill "${name}":\n\n${content}`;
        }
      }
      return `Skill "${name}" not found in any of the discovery paths.`;
    },
    name: 'load_skill',
    parameters: loadSkillSchema,
  });
}
