import * as v from 'valibot';
import { defineTool } from '@flue/runtime';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { skillDirs } from '../storage/paths';

const loadSkillSchema = v.object({
  name: v.string(),
});

export function createLoadSkillTool(workspaceRoot: string) {
  return defineTool({
    description:
      'Load the instructions/guidance for a specific skill (e.g. deslop, thermonuclear review) from local or global directories.',
    execute: async ({ name }) => {
      if (name.includes('/') || name.includes('\\') || name.includes('..')) {
        return 'Invalid skill name.';
      }
      const dirs = skillDirs(workspaceRoot).map((dir) => path.join(dir, name));

      for (const dir of dirs) {
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
