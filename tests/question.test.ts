import { describe, test, expect } from 'bun:test';
import { askUserQuestions } from '../src/permissions/middleware';
import { createAskQuestionTool } from '../src/tools/ask-question';

describe('Interactive Question Tool', () => {
  test('askUserQuestions resolves with defaults in headless/standalone mode', async () => {
    const questions = [
      {
        id: 'q1',
        question: 'Select option',
        type: 'select',
        options: ['A', 'B'],
        default: 'B',
      },
      {
        id: 'q2',
        question: 'Select multiple',
        type: 'multiselect',
        options: ['X', 'Y'],
        default: ['X'],
      },
      {
        id: 'q3',
        question: 'Input text',
        type: 'input',
        default: 'hello',
      },
    ];

    const answers = await askUserQuestions(questions);
    expect(answers).toEqual({
      q1: 'B',
      q2: ['X'],
      q3: 'hello',
    });
  });

  test('createAskQuestionTool returns valid tool instance', async () => {
    const tool = createAskQuestionTool();
    expect(tool.name).toBe('ask_question');
    expect(tool.execute).toBeDefined();

    const result = await tool.execute({
      questions: [
        {
          id: 'test',
          question: 'Hello?',
          type: 'input',
          default: 'world',
        },
      ],
    });

    expect(result).toEqual({
      answers: { test: 'world' },
      message: 'Questions answered successfully.',
    });
  });
});
