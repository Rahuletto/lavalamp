import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { askUserQuestions } from '../permissions/middleware';

const questionSchema = v.object({
  id: v.string(),
  question: v.string(),
  type: v.union([v.literal('select'), v.literal('multiselect'), v.literal('input')]),
  options: v.optional(v.array(v.string())),
  default: v.optional(v.union([v.string(), v.array(v.string())])),
});

const askQuestionSchema = v.object({
  questions: v.array(questionSchema),
});

export function createAskQuestionTool() {
  return defineTool({
    description:
      'Ask the user one or more interactive questions (single-choice, multi-choice, or free-text input). Use this when you need user preferences, design decisions, clarification, or feedback on options before proceeding.',
    execute: async (args) => {
      const answers = await askUserQuestions(args.questions);
      return JSON.stringify({
        answers,
        message: 'Questions answered successfully.',
      });
    },
    name: 'ask_question',
    parameters: askQuestionSchema,
  });
}
