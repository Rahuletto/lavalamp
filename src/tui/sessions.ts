import * as fs from "fs";
import * as path from "path";
import { type Message } from "./state";

const SESSIONS_DIR = path.join(
  process.env.HOME ?? "~",
  ".lavalamp",
  "sessions",
);

function ensureSessionsDir() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

export function nameSession(messages: Message[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "Empty Session";
  
  let text = firstUser.content
    .replace(/^<<PLAN_MODE>>\s*/, "") // Strip plan mode tag
    .replace(/^\/\w+\s*/, "")        // Strip slash commands (e.g., /ask)
    .replace(/[#@][^\s]*/g, "")      // Strip autocomplete prefixes/skills
    .replace(/\s+/g, " ")            // Normalize spacing
    .trim();

  if (!text) return "Chat Session";

  // Capitalize first letter
  text = text.charAt(0).toUpperCase() + text.slice(1);

  // Truncate to a reasonable length, avoiding word cutoff if possible
  const maxLength = 45;
  if (text.length > maxLength) {
    const truncated = text.slice(0, maxLength);
    const lastSpace = truncated.lastIndexOf(" ");
    if (lastSpace > maxLength * 0.7) {
      text = truncated.slice(0, lastSpace) + "...";
    } else {
      text = truncated + "...";
    }
  }

  return text;
}

export function saveSession(messages: Message[], name: string, existingId?: string): string {
  ensureSessionsDir();
  const id = existingId || `session_${Date.now()}`;
  const file = path.join(SESSIONS_DIR, `${id}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ id, name, messages, savedAt: Date.now() }),
  );
  return id;
}

export function listSessions(): Array<{
  id: string;
  name: string;
  savedAt: number;
  messageCount: number;
}> {
  ensureSessionsDir();
  const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
  const sessions: Array<{
    id: string;
    name: string;
    savedAt: number;
    messageCount: number;
  }> = [];
  for (const f of files) {
    try {
      const data = JSON.parse(
        fs.readFileSync(path.join(SESSIONS_DIR, f), "utf-8"),
      );
      sessions.push({
        id: data.id,
        name: data.name ?? f.replace(".json", ""),
        savedAt: data.savedAt ?? 0,
        messageCount: (data.messages ?? []).length,
      });
    } catch {}
  }
  sessions.sort((a, b) => b.savedAt - a.savedAt);
  return sessions.slice(0, 20);
}

export function loadSession(sessionId: string): Message[] | null {
  ensureSessionsDir();
  const file = path.join(SESSIONS_DIR, `${sessionId}.json`);
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    return data.messages ?? null;
  } catch {
    return null;
  }
}
