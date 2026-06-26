import { resolve, relative, isAbsolute, basename } from 'node:path';

const SECRET_PATTERNS = [
  /\.env$/,
  /\.env\./,
  /\.dev\.vars$/,
  /\.dev\.vars\./,
  /\.credentials$/,
  /\.credentials\./,
  /\.secret$/,
  /\.secret\./,
  /\.key$/,
  /\.pem$/,
  /\.p12$/,
  /\.pfx$/,
  /\.jks$/,
];

const SECRET_EXCLUSIONS = [
  /\.env\.example$/,
  /\.env\.template$/,
  /\.env\.sample$/,
  /\.envrc$/, // direnv config, not a secret
];

export function isSecretFile(filePath: string): boolean {
  const name = basename(filePath);
  if (SECRET_EXCLUSIONS.some((p) => p.test(name))) {
    return false;
  }
  return SECRET_PATTERNS.some((p) => p.test(name));
}

export class WorkspaceGuard {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  resolve(target: string): string {
    if (!isAbsolute(target)) {
      return resolve(this.root, target);
    }
    return resolve(target);
  }

  assertInside(target: string): void {
    const resolved = this.resolve(target);
    const rel = relative(this.root, resolved);

    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new WorkspaceViolationError(resolved, this.root);
    }
  }

  assertNotSecret(target: string): void {
    const resolved = this.resolve(target);
    if (isSecretFile(resolved)) {
      throw new SecretFileAccessError(resolved);
    }
  }

  assertAccessible(target: string): void {
    const resolved = this.resolve(target);
    this.assertInside(resolved);
    this.assertNotSecret(resolved);
  }

  isInside(target: string): boolean {
    try {
      this.assertInside(target);
      return true;
    } catch {
      return false;
    }
  }

  isAccessible(target: string): boolean {
    try {
      this.assertAccessible(target);
      return true;
    } catch {
      return false;
    }
  }

  constrain(target: string): string {
    this.assertAccessible(target);
    return this.resolve(target);
  }
}

export class WorkspaceViolationError extends Error {
  constructor(target: string, root: string) {
    super(
      `Access denied: ${target} is outside workspace root (${root}). ` +
        `The agent can only operate inside the assigned workspace.`,
    );
    this.name = 'WorkspaceViolationError';
  }
}

export class SecretFileAccessError extends Error {
  constructor(target: string) {
    super(
      `Access denied: ${target} is a secret/sensitive file. ` +
        `The agent cannot read or write credential files (.env, .dev.vars, .credentials, etc.).`,
    );
    this.name = 'SecretFileAccessError';
  }
}
