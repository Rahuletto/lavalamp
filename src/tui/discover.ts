import * as fs from "fs";
import * as path from "path";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  "__pycache__",
  ".cache",
  ".turbo",
  "coverage",
  ".vinxi",
  ".nuxt",
]);

function loadGitignore(dir: string): string[] {
  try {
    return fs
      .readFileSync(path.join(dir, ".gitignore"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

function matchGitignore(name: string, pattern: string): boolean {
  const p = pattern.replace(/\/$/, "");
  if (p.startsWith("!")) return false;
  if (p.includes("*"))
    return new RegExp(
      "^" + p.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$",
    ).test(name);
  return name === p || name.startsWith(p + "/");
}

export function walkFiles(dir: string): string[] {
  const results: string[] = [];
  const gitignorePatterns = loadGitignore(dir);
  const walk = (d: string, rel: string, depth: number) => {
    if (depth > 6) return;
    try {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (gitignorePatterns.some((p) => matchGitignore(entry.name, p)))
          continue;
        const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory())
          walk(path.join(d, entry.name), entryRel, depth + 1);
        else if (
          /\.(ts|tsx|js|jsx|json|md|py|go|rs|css|html|yaml|yml|toml|sh|sql|vue|svelte)$/.test(
            entry.name,
          )
        )
          results.push(entryRel);
      }
    } catch {}
  };
  walk(dir, "", 0);
  return results.sort();
}

export function discoverSkills(cwd: string): string[] {
  const skills: string[] = [];
  const home = process.env.HOME ?? "";
  for (const dir of [
    path.join(cwd, ".agents", "skills"),
    path.join(cwd, "..", ".agents", "skills"),
    home ? path.join(home, ".agents", "skills") : "",
  ]) {
    if (!dir) continue;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (
          entry.isDirectory() &&
          fs.existsSync(path.join(dir, entry.name, "SKILL.md"))
        )
          skills.push(entry.name);
      }
    } catch {}
  }
  return [...new Set(skills)].sort();
}

export function fuzzyMatch(query: string, target: string): number | null {
  let qi = 0,
    score = 0,
    last = -1;
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) {
      if (last === ti - 1) score += 10;
      if (ti === 0 || "/-_ ".includes(target[ti - 1])) score += 20;
      if (ti === qi) score += 5;
      if (ti > 0 && target[ti - 1] === ".") score += 15;
      last = ti;
      qi++;
    }
  }
  return qi < query.length ? null : score + Math.max(0, 30 - target.length);
}

export function fuzzySearch(
  query: string,
  candidates: string[],
): { item: string; score: number }[] {
  if (!query) return candidates.map((item) => ({ item, score: 0 }));
  return candidates
    .map((item) => {
      const s = fuzzyMatch(query.toLowerCase(), item.toLowerCase());
      return s !== null ? { item, score: s } : null;
    })
    .filter((r): r is { item: string; score: number } => r !== null)
    .sort((a, b) => b.score - a.score);
}
