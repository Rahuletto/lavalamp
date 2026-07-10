/**
 * Post-build patch: enable image (PromptImage) passthrough in the generated
 * Flue IPC server.
 *
 * The generated `dist/server.mjs` validates IPC prompt messages with
 * `parseIpcAgentMessage`, which strips everything except { type, requestId,
 * message }. The `DirectAgentPayload` type supports `images?: PromptImage[]`,
 * and `invokeDirectAttached` accepts them — the server just never passes them
 * through. This patch fixes both spots so the TUI can send images directly to
 * vision-capable models.
 *
 * Idempotent: safe to run multiple times.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const serverPath = path.resolve(import.meta.dir, '..', 'dist', 'server.mjs');

if (!fs.existsSync(serverPath)) {
  console.error('[patch-server] dist/server.mjs not found — run `flue build` first');
  process.exit(1);
}

let source = fs.readFileSync(serverPath, 'utf8');
let patched = 0;

// Patch 1: extract `images` from the raw IPC message in parseIpcAgentMessage
const parseOld = '\t\tmessage: raw.message\n\t};';
const parseNew =
  '\t\tmessage: raw.message,\n\t\timages: Array.isArray(raw.images) ? raw.images : void 0\n\t};';

if (source.includes(parseOld)) {
  source = source.replace(parseOld, parseNew);
  patched++;
}

// Patch 2: pass `images` through to invokeDirectAttached
const invokeOld = 'payload: { message: message.message },';
const invokeNew = 'payload: { message: message.message, images: message.images },';

if (source.includes(invokeOld)) {
  source = source.replace(invokeOld, invokeNew);
  patched++;
}

if (patched > 0) {
  fs.writeFileSync(serverPath, source);
  console.error(`[patch-server] applied ${patched} patch(es) to dist/server.mjs`);
} else {
  console.error('[patch-server] already patched — no changes needed');
}
