import { classifyShellCommand } from '../permissions/shell-policy';

export interface MutationBackupPlan {
  paths: string[];
}

function readStringArg(
  args: Record<string, unknown>,
  names: string[],
): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function extractHashlinePaths(value: unknown): string[] {
  if (typeof value !== 'string') {
    return [];
  }

  const paths: string[] = [];
  for (const line of value.split('\n')) {
    const match = /^\[([^#\]]+)#[^\]]+\]/.exec(line.trim());
    const matchedPath = match?.[1];
    if (matchedPath !== undefined) {
      paths.push(matchedPath);
    }
  }
  return paths;
}

export function planMutationBackup(
  name: string,
  args: Record<string, unknown>,
): MutationBackupPlan | null {
  if (name === 'write' || name === 'edit') {
    const paths = [
      readStringArg(args, ['file_path', 'path', 'filePath']),
      ...extractHashlinePaths(args.patch),
      ...extractHashlinePaths(args.content),
      ...extractHashlinePaths(args.input),
    ].filter((value): value is string => value !== undefined);
    return paths.length > 0 ? { paths } : null;
  }

  if (name === 'rename') {
    const paths = [
      readStringArg(args, ['oldPath', 'old_path', 'from']),
      readStringArg(args, ['newPath', 'new_path', 'to']),
    ].filter((value): value is string => value !== undefined);
    return paths.length > 0 ? { paths } : null;
  }

  if (name === 'bash') {
    const command = readStringArg(args, ['command', 'cmd']) ?? '';
    const classification = classifyShellCommand(command);
    if (classification.kind === 'read') {
      return null;
    }
    const paths = classification.mutationPaths;
    return paths.length > 0 ? { paths } : null;
  }

  return null;
}
