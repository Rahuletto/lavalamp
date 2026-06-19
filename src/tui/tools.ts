import * as fs from "fs";
import * as path from "path";

export function stripCwd(fullPath: string, cwd: string): string {
  if (fullPath.startsWith(cwd)) return "~" + fullPath.slice(cwd.length);
  const home = process.env.HOME ?? "";
  if (home && fullPath.startsWith(home))
    return "~" + fullPath.slice(home.length);
  return fullPath;
}

export function summarizeToolArgs(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
): string {
  switch (name) {
    case "deploy_parallel_subs": {
      const queries = Array.isArray(args.queries) ? args.queries : [];
      return `${queries.length} quer${queries.length === 1 ? "y" : "ies"}`;
    }
    case "bash": {
      const cmd =
        typeof args.command === "string"
          ? args.command
          : typeof args.cmd === "string"
            ? args.cmd
            : "";
      return cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
    }
    case "read": {
      const fp =
        typeof args.file_path === "string"
          ? args.file_path
          : typeof args.path === "string"
            ? args.path
            : "";
      const rest: string[] = [];
      if (args.offset) rest.push(`L${args.offset}`);
      if (args.limit) rest.push(`${args.limit} lines`);
      return stripCwd(fp, cwd) + (rest.length ? ` ${rest.join(":")}` : "");
    }
    case "write":
    case "edit": {
      const fp =
        typeof args.file_path === "string"
          ? args.file_path
          : typeof args.path === "string"
            ? args.path
            : "";
      return stripCwd(fp, cwd);
    }
    case "glob":
    case "grep": {
      return typeof args.pattern === "string" ? args.pattern : "";
    }
    default: {
      const entries = Object.entries(args);
      if (!entries.length) return "";
      const parts: string[] = [];
      for (const [, v] of entries.slice(0, 2)) {
        if (typeof v === "string")
          parts.push(v.length > 30 ? v.slice(0, 27) + "..." : v);
        else if (typeof v === "number" || typeof v === "boolean")
          parts.push(String(v));
      }
      return parts.join(" ");
    }
  }
}

export function summarizeToolResult(
  name: string,
  args: Record<string, unknown>,
  result: unknown,
  cwd: string,
): string {
  const raw =
    typeof result === "string"
      ? result
      : result != null
        ? JSON.stringify(result)
        : "";
  const parsed = (() => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  })();
  const str = parsed && typeof parsed === "string" ? parsed : raw;

  switch (name) {
    case "deploy_parallel_subs": {
      const marker = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
      const queries = Array.isArray(marker?.queries) ? marker.queries : [];
      return `${queries.length || "parallel"} research agent${queries.length === 1 ? "" : "s"} deployed`;
    }
    case "read": {
      const fp =
        typeof args.file_path === "string"
          ? args.file_path
          : typeof args.path === "string"
            ? args.path
            : "";
      const lines = str.split("\n").length;
      return `${stripCwd(fp, cwd)} (${lines} lines)`;
    }
    case "bash": {
      const out = str.trim();
      const lines = out.split("\n").length;
      return lines <= 3
        ? out.split("\n").join(" ").slice(0, 60)
        : `${lines} lines of output`;
    }
    case "write":
    case "edit":
    case "patch": {
      if (parsed && typeof parsed === "object" && parsed !== null) {
        const p = parsed as Record<string, unknown>;
        if (p.file_path) return `wrote ${stripCwd(String(p.file_path), cwd)}`;
        if (p.path) return `wrote ${stripCwd(String(p.path), cwd)}`;
      }
      return str.slice(0, 60) || "done";
    }
    case "glob": {
      if (Array.isArray(parsed)) return `${parsed.length} files found`;
      if (Array.isArray(str.match(/\n/)))
        return `${str.split("\n").length} files`;
      return str.slice(0, 60) || "no matches";
    }
    case "grep": {
      if (Array.isArray(parsed)) return `${parsed.length} matches`;
      return str.split("\n").length + " matches";
    }
    default: {
      if (!str) return "";
      return str.length > 60 ? str.slice(0, 57) + "..." : str;
    }
  }
}

export function looksLikeDiff(s: string): boolean {
  if (!s.includes("@@")) return false;
  const lines = s.split("\n");
  let hasHunk = false;
  let hasChange = false;
  for (const line of lines) {
    if (/^@@\s/.test(line)) hasHunk = true;
    if (/^[+-]/.test(line) && !/^(\+\+\+|---)\s/.test(line)) hasChange = true;
    if (hasHunk && hasChange) return true;
  }
  return false;
}

export function generateSyntheticDiff(
  filePath: string,
  oldText: string,
  newText: string,
): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const oldCount = oldLines.length;
  const newCount = newLines.length;
  let diff = `--- a/${filePath}\n+++ b/${filePath}\n@@ -1,${oldCount} +1,${newCount} @@\n`;
  for (const line of oldLines) {
    diff += `-${line}\n`;
  }
  for (const line of newLines) {
    diff += `+${line}\n`;
  }
  return diff;
}

export function extractResultText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") {
    try {
      const parsed = JSON.parse(result);
      return extractResultText(parsed);
    } catch {
      return result;
    }
  }
  if (typeof result !== "object") return String(result);
  if (Array.isArray(result)) {
    return result.map((item) => extractResultText(item)).join("\n");
  }
  const obj = result as Record<string, unknown>;
  if (typeof obj.content === "string") return obj.content;
  if (Array.isArray(obj.content)) {
    const parts: string[] = [];
    for (const item of obj.content) {
      if (item && typeof item === "object" && typeof (item as any).text === "string") {
        parts.push((item as any).text);
      }
    }
    if (parts.length) return parts.join("\n");
  }
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.message === "string") return obj.message;
  if (typeof obj.output === "string") return obj.output;
  if (typeof obj.stdout === "string") return obj.stdout;
  return JSON.stringify(result, null, 2);
}

export const EXT_LANG_MAP: Record<string, string> = {
  ts: "typescript", tsx: "typescriptreact", js: "javascript", jsx: "javascriptreact",
  mjs: "javascript", cjs: "javascript",
  py: "python", rb: "ruby", rs: "rust", go: "go", java: "java", kt: "kotlin",
  c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp",
  css: "css", scss: "scss", less: "less", html: "html", xml: "xml",
  json: "javascript", yaml: "yaml", yml: "yaml", toml: "ini",
  md: "markdown", sql: "sql", sh: "bash", bash: "bash", zsh: "bash",
  dockerfile: "dockerfile", makefile: "makefile", lua: "lua",
  swift: "swift", dart: "dart", ex: "elixir", erl: "erlang",
  vue: "html", svelte: "html",
};

export function detectLanguage(filePath: string): string | undefined {
  const base = filePath.split("/").pop() ?? "";
  const lower = base.toLowerCase();
  if (lower === "dockerfile") return "dockerfile";
  if (lower === "makefile") return "makefile";
  const ext = lower.split(".").pop() ?? "";
  return EXT_LANG_MAP[ext];
}

const FILE_PATH_RE = /(?:~\/|[.\/])?[\w./-]+\.(?:ts|tsx|js|jsx|py|rb|rs|go|java|kt|c|cpp|h|hpp|cs|css|scss|less|html|xml|json|yaml|yml|toml|md|sql|sh|bash|zsh|lua|swift|dart|ex|erl|vue|svelte|tsx?|jsx?)/g;

export function extractFilePaths(text: string, cwd: string): string[] {
  const found = new Set<string>();
  const matches = text.match(FILE_PATH_RE);
  if (!matches) return [];
  for (const m of matches) {
    const cleaned = m.replace(/[`,\s]*$/, "");
    const full = cleaned.startsWith("~")
      ? (process.env.HOME ?? "") + cleaned.slice(1)
      : cleaned.startsWith("./") || cleaned.startsWith("../")
        ? path.resolve(cwd, cleaned)
        : cleaned;
    if (fs.existsSync(full)) {
      found.add(full);
    }
  }
  return [...found];
}
