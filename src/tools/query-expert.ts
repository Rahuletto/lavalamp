import * as v from 'valibot';
import { defineTool } from '@flue/runtime';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  EXPERT_IDS,
  EXPERT_PROFILES,
  expertRoutingTable,
  isExpertId,
} from '../config/experts';

const queryExpertSchema = v.object({
  expert: v.union([
    v.literal('ui'),
    v.literal('refactor'),
    v.literal('logic'),
    v.literal('database'),
    v.literal('oracle'),
    v.literal('research'),
    v.literal('critique'),
    v.literal('spectacle'),
  ]),
  prompt: v.string(),
});

function toolDescription(): string {
  return [
    'Delegate a specialized READ-ONLY task to a domain expert agent (Mixture of Experts).',
    'Experts return guidance; you apply edits. Pick the expert that matches the domain.',
    '',
    expertRoutingTable(),
    '',
    'Write a focused prompt: include goal, relevant paths, and constraints.',
    'Do not use for trivial one-file edits you can finish yourself.',
  ].join('\n');
}

export function createQueryExpertTool(workspaceRoot: string) {
  const serverPath =
    process.env.LAVALAMP_SERVER_PATH ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs');

  return defineTool({
    description: toolDescription(),
    execute: async ({ expert, prompt }) => {
      if (!isExpertId(expert)) {
        return `Unknown expert "${expert}". Valid: ${EXPERT_IDS.join(', ')}`;
      }

      const profile = EXPERT_PROFILES[expert];
      const framedPrompt = [
        `[expert:${expert} — ${profile.displayName}]`,
        profile.summary,
        '',
        'Task from the main agent:',
        prompt,
      ].join('\n');

      return new Promise<string>((resolve, reject) => {
        const instanceId = `expert_${randomUUID().slice(0, 8)}`;
        const child = spawn(process.execPath, [serverPath], {
          cwd: workspaceRoot,
          env: {
            ...process.env,
            FLUE_CLI_ID: instanceId,
            FLUE_CLI_NAME: expert,
            FLUE_CLI_TARGET: 'agent',
            FLUE_INTERNAL_CLI_IPC: '1',
            FLUE_MODE: 'local',
            LAVALAMP_SERVER_PATH: serverPath,
            LAVALAMP_WORKSPACE: workspaceRoot,
          },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });

        let outputText = '';
        let stderrText = '';
        const requestId = `req_${randomUUID()}`;

        if (child.stderr) {
          child.stderr.on('data', (chunk) => {
            stderrText += chunk.toString('utf8');
          });
        }

        const onMessage = (raw: Record<string, unknown>) => {
          if (raw.type === 'ready' && raw.instanceId === instanceId) {
            child.send({
              message: framedPrompt,
              requestId,
              type: 'prompt',
            });
            return;
          }

          if (raw.requestId !== requestId) {
            return;
          }

          if (
            raw.type === 'event' &&
            raw.event !== null &&
            raw.event !== undefined &&
            typeof raw.event === 'object' &&
            (raw.event as Record<string, unknown>).type === 'text_delta'
          ) {
            const evt = raw.event as Record<string, unknown>;
            const text =
              typeof evt.text === 'string'
                ? evt.text
                : typeof evt.delta === 'string'
                  ? evt.delta
                  : '';
            outputText += text ?? '';
          }

          if (raw.type === 'result') {
            cleanup();
            const body = outputText.trim();
            resolve(
              body.length > 0
                ? `[${expert}] ${body}`
                : `[${expert}] (empty response)`,
            );
          }

          if (raw.type === 'error') {
            cleanup();
            const errObj =
              raw.error !== null &&
              raw.error !== undefined &&
              typeof raw.error === 'object'
                ? (raw.error as Record<string, unknown>)
                : null;
            const msg =
              errObj !== null && typeof errObj.message === 'string'
                ? errObj.message
                : 'Expert session failed';
            const extra = stderrText.trim() ? `\nStderr:\n${stderrText.trim()}` : '';
            reject(new Error(`[${expert}] ${msg}${extra}`));
          }
        };

        const onExit = (code: number | null) => {
          cleanup();
          if (code !== 0 && code !== null) {
            const extra = stderrText.trim() ? `\nStderr:\n${stderrText.trim()}` : '';
            reject(
              new Error(
                `[${expert}] Expert process crashed with code ${code}.${extra}`,
              ),
            );
          } else {
            resolve(
              outputText.trim() ||
                `[${expert}] Expert exited with code ${code}`,
            );
          }
        };

        const cleanup = () => {
          child.off('message', onMessage);
          child.off('exit', onExit);
          child.kill('SIGTERM');
        };

        child.on('message', onMessage);
        child.on('exit', onExit);
      });
    },
    name: 'query_expert',
    parameters: queryExpertSchema,
  });
}
