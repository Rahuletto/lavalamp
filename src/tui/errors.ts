export function formatTuiError(error: Error): string {
  const message = error.message.trim();
  if (/\b429\b|rate.?limit/i.test(message)) {
    return 'model provider rate limit reached (429); wait for cooldown and retry';
  }
  return message.split('\n')[0] ?? 'Unknown error';
}
