export type ShellCommandKind = 'read' | 'mutation' | 'unknown';

export interface ShellCommandClassification {
  kind: ShellCommandKind;
  mutationPaths: string[];
}

const READ_ONLY_COMMANDS = new Set([
  'cat',
  'git',
  'grep',
  'ls',
  'pwd',
  'rg',
  'sed',
  'find',
]);

const MUTATING_COMMANDS = new Set([
  'chmod',
  'chown',
  'cp',
  'install',
  'ln',
  'mkdir',
  'mv',
  'rm',
  'sed',
  'tee',
  'touch',
  'truncate',
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'branch',
  'diff',
  'log',
  'show',
  'status',
]);

function unquoteShellWord(word: string): string {
  if (
    (word.startsWith('"') && word.endsWith('"')) ||
    (word.startsWith("'") && word.endsWith("'"))
  ) {
    return word.slice(1, -1);
  }
  return word;
}

function tokenizeShellSegment(segment: string): string[] {
  return (
    segment.match(/"[^"]+"|'[^']+'|[^\s;&|()<>]+/g)?.map(unquoteShellWord) ?? []
  );
}

function looksLikePath(value: string): boolean {
  if (
    value.length === 0 ||
    value === '.' ||
    value === './' ||
    value.startsWith('-')
  ) {
    return false;
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
    return false;
  }
  return (
    value.includes('/') ||
    value.startsWith('.') ||
    /\.[A-Za-z0-9]{1,8}$/.test(value)
  );
}

function commandName(words: string[]): string | undefined {
  for (const word of words) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      continue;
    }
    return word;
  }
  return undefined;
}

function extractSedMutationPaths(words: string[]): string[] {
  const paths: string[] = [];
  let scriptConsumed = false;
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (word === undefined) {
      continue;
    }
    if (word === '-e' || word === '-f') {
      i++;
      continue;
    }
    if (word.startsWith('-')) {
      continue;
    }
    if (!scriptConsumed) {
      scriptConsumed = true;
      continue;
    }
    if (looksLikePath(word)) {
      paths.push(word);
    }
  }
  return paths;
}

function hasMutationRedirection(command: string): boolean {
  return /(?:^|[\s])(?:\d?>|>>|&>)\s*(?:"[^"]+"|'[^']+'|[^\s;&|]+)/.test(
    command,
  );
}

export function extractShellMutationPaths(command: string): string[] {
  const paths: string[] = [];
  const redirectMatches = command.matchAll(
    /(?:^|[\s])(?:\d?>|>>|&>)\s*("[^"]+"|'[^']+'|[^\s;&|]+)/g,
  );
  for (const match of redirectMatches) {
    const target = match[1];
    if (target !== undefined) {
      paths.push(unquoteShellWord(target));
    }
  }

  const words = tokenizeShellSegment(command);
  const name = commandName(words);
  if (name === undefined || !MUTATING_COMMANDS.has(name)) {
    return [...new Set(paths)];
  }

  if (
    name === 'sed' &&
    !words.includes('-i') &&
    !words.some((w) => w.startsWith('-i'))
  ) {
    return [...new Set(paths)];
  }

  if (name === 'sed') {
    return [...new Set([...paths, ...extractSedMutationPaths(words)])];
  }

  for (const word of words.slice(1)) {
    if (looksLikePath(word)) {
      paths.push(word);
    }
  }

  return [...new Set(paths)];
}

function isReadOnlySegment(segment: string): boolean {
  const words = tokenizeShellSegment(segment);
  const name = commandName(words);
  if (name === undefined || !READ_ONLY_COMMANDS.has(name)) {
    return false;
  }
  if (name === 'sed') {
    return (
      words.includes('-n') &&
      !words.includes('-i') &&
      !words.some((w) => w.startsWith('-i'))
    );
  }
  if (name === 'find') {
    return !words.some((word) =>
      ['-delete', '-exec', '-execdir', '-ok', '-okdir'].includes(word),
    );
  }
  if (name === 'git') {
    const subcommand = words.find(
      (word, index) => index > 0 && !word.startsWith('-'),
    );
    return (
      subcommand !== undefined && READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)
    );
  }
  return true;
}

export function classifyShellCommand(
  command: string,
): ShellCommandClassification {
  const mutationPaths = extractShellMutationPaths(command);
  if (mutationPaths.length > 0 || hasMutationRedirection(command)) {
    return { kind: 'mutation', mutationPaths };
  }

  const segments = command
    .split(/\s*(?:&&|\|\||\||;)\s*/g)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length > 0 && segments.every(isReadOnlySegment)) {
    return { kind: 'read', mutationPaths: [] };
  }

  const firstWords = tokenizeShellSegment(command);
  const firstName = commandName(firstWords);
  if (firstName !== undefined && MUTATING_COMMANDS.has(firstName)) {
    return { kind: 'mutation', mutationPaths };
  }

  return { kind: 'unknown', mutationPaths };
}

export function isReadOnlyShellCommand(command: string): boolean {
  return classifyShellCommand(command).kind === 'read';
}
