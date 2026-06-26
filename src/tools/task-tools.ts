import * as v from 'valibot';
import { defineTool } from '@flue/runtime';
import type { TaskStore } from './task-store';

const createTaskSchema = v.object({
  description: v.optional(v.string()),
  title: v.string(),
});

const idSchema = v.object({
  id: v.number(),
});

const editTaskSchema = v.object({
  description: v.optional(v.string()),
  id: v.number(),
  title: v.optional(v.string()),
});

const listTasksSchema = v.object({
  status: v.optional(v.string()),
});

export function createTaskTools(store: TaskStore) {
  return [
    defineTool({
      description:
        'Create a new task in the session task list. Returns the task with its ID. Use this to break down complex work into trackable steps.',
      execute: async (args) => {
        const task = store.create(args.title, args.description);
        return `Created task #${task.id}: ${task.title}`;
      },
      name: 'create_task',
      parameters: createTaskSchema,
    }),

    defineTool({
      description: 'Mark a task as in-progress (being worked on) by its ID.',
      execute: async (args) => {
        const task = store.get(args.id);
        if (!task) throw new Error(`Task #${args.id} not found`);
        task.status = 'in_progress';
        task.updatedAt = new Date().toISOString();
        return `Started task #${task.id}: ${task.title}`;
      },
      name: 'start_task',
      parameters: idSchema,
    }),

    defineTool({
      description:
        'Mark a task as completed by its ID. Crosses it off the list.',
      execute: async (args) => {
        const task = store.complete(args.id);
        return `Completed task #${task.id}: ${task.title}`;
      },
      name: 'complete_task',
      parameters: idSchema,
    }),

    defineTool({
      description:
        'Skip/cancel a task by its ID. Use when a task is no longer needed.',
      execute: async (args) => {
        const task = store.skip(args.id);
        return `Skipped task #${task.id}: ${task.title}`;
      },
      name: 'skip_task',
      parameters: idSchema,
    }),

    defineTool({
      description: 'Edit a task title or description by its ID.',
      execute: async (args) => {
        const task = store.edit(args.id, {
          title: args.title,
          description: args.description,
        });
        return `Updated task #${task.id}: ${task.title}${task.description ? ` — ${task.description}` : ''}`;
      },
      name: 'edit_task',
      parameters: editTaskSchema,
    }),

    defineTool({
      description:
        'Delete a task by its ID. Permanently removes it from the list.',
      execute: async (args) => {
        const task = store.delete(args.id);
        return `Deleted task #${task.id}: ${task.title}`;
      },
      name: 'delete_task',
      parameters: idSchema,
    }),

    defineTool({
      description:
        'List all tasks with their status. Optionally filter by status: pending, in_progress, completed, skipped.',
      execute: async (args) => {
        const status = args.status as any;
        const tasks = store.list(status);
        if (tasks.length === 0) return 'No tasks found.';

        const statusIcon: Record<string, string> = {
          pending: '[ ]',
          in_progress: '[>]',
          completed: '[x]',
          skipped: '[-]',
        };

        return tasks
          .map((t) => {
            const icon = statusIcon[t.status] ?? '[?]';
            const desc = t.description ? ` — ${t.description}` : '';
            return `${icon} #${t.id} ${t.title}${desc}`;
          })
          .join('\n');
      },
      name: 'list_tasks',
      parameters: listTasksSchema,
    }),
  ];
}
