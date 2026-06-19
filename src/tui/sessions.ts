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
  if (!firstUser) return "empty";
  const text = firstUser.content
    .replace(/^\/\w+\s*/, "")
    .replace(/[#@][^\s]*/g, "")
    .trim();
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return slug || "chat";
}

export function saveSession(messages: Message[], name: string): string {
  ensureSessionsDir();
  const id = `session_${Date.now()}`;
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
