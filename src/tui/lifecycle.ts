import { LAVA_LAMP_FRAMES } from './lava-art';
import { COLORS } from './theme';

function hexToAnsi(hex: string): string {
  const value = hex.replace('#', '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `\u001B[38;2;${r};${g};${b}m`;
}

export interface TuiLifetime {
  finished: Promise<void>;
  markDestroyed(): void;
}

export function createTuiLifetime(): TuiLifetime {
  let markDestroyed = () => {};
  const finished = new Promise<void>((resolve) => {
    markDestroyed = resolve;
  });
  return { finished, markDestroyed };
}

export function formatExitSummary(sessionId: string): string {
  const reset = '\u001B[0m';
  const accentColor = hexToAnsi(COLORS.accent);
  const dimColor = hexToAnsi(COLORS.dim);
  const cyanColor = hexToAnsi(COLORS.cyan);
  const whiteColor = hexToAnsi(COLORS.white);
  const banner = (LAVA_LAMP_FRAMES[0] ?? []).join('\n');
  return (
    `\n${accentColor}${banner}${reset}\n\n` +
    `${dimColor}session:${reset} ${whiteColor}${sessionId}${reset}\n` +
    `${dimColor}continue:${reset} ${cyanColor}lavalamp --continue ${sessionId}${reset}\n`
  );
}
