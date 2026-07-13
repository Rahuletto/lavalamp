import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
} from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';

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
    this.root = realpathSync(resolve(root));
  }

  resolve(target: string): string {
    if (!isAbsolute(target)) {
      return resolve(this.root, target);
    }
    return resolve(target);
  }

  assertInside(target: string): void {
    const resolved = this.resolve(target);
    const canonical = this.canonicalize(resolved);
    const rel = relative(this.root, canonical);

    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new WorkspaceViolationError(canonical, this.root);
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
    const canonical = this.canonicalize(this.resolve(target));
    this.assertNotSecret(canonical);
    return canonical;
  }

  constrainEntry(target: string): string {
    const resolved = this.resolve(target);
    const parent = this.canonicalize(dirname(resolved));
    this.assertInside(parent);
    const entry = resolve(parent, basename(resolved));
    this.assertNotSecret(entry);

    try {
      if (lstatSync(entry).isSymbolicLink()) {
        throw new WorkspaceViolationError(entry, this.root);
      }
    } catch (error: unknown) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code !== 'ENOENT') {
        throw error;
      }
    }

    return entry;
  }

  private canonicalize(target: string): string {
    const missingParts: string[] = [];
    let current = target;

    while (true) {
      try {
        lstatSync(current);
        break;
      } catch (error: unknown) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? (error as { code?: unknown }).code
            : undefined;
        if (code !== 'ENOENT') {
          throw error;
        }
        const parent = dirname(current);
        if (parent === current) {
          throw error;
        }
        missingParts.unshift(basename(current));
        current = parent;
      }
    }

    return resolve(realpathSync(current), ...missingParts);
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
