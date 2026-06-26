import { StyledText, bold, dim } from '@opentui/core';
import type { TextChunk } from '@opentui/core';

export function shortenPath(p: string): string {
  const home = process.env.HOME ?? "";
  if (home && p.startsWith(home)) {return `~${  p.slice(home.length)}`;}
  return p;
}

export function hexToAnsi(hex: string): string {
  const cleaned = hex.replace("#", "");
  const r = Number.parseInt(cleaned.slice(0, 2), 16);
  const g = Number.parseInt(cleaned.slice(2, 4), 16);
  const b = Number.parseInt(cleaned.slice(4, 6), 16);
  return `\u001B[38;2;${r};${g};${b}m`;
}

export function styleBashCommand(cmd: string): StyledText {
  const parts = cmd.split(/(\s+)/);
  const chunks: TextChunk[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? "";
    if (/^\s+$/.test(part)) {
      chunks.push({ __isChunk: true, text: part });
    } else if (i === 0) {
      chunks.push(bold(part));
    } else if (part.startsWith("-")) {
      chunks.push(dim(part));
    } else {
      chunks.push({ __isChunk: true, text: part });
    }
  }
  return new StyledText(chunks);
}

