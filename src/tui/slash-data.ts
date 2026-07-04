export const HELP_COMMANDS: [string, string][] = [
  ['/help', 'Show this help'],
  ['/clear', 'New session'],
  ['/sessions', 'Switch sessions'],
  ['/compact', 'Compact context'],
  ['/memory', 'Show project memory'],
  ['/model', 'Show/change model'],
  ['/models', 'Show/change model'],
  ['/gateway', 'Show/change AI Gateway'],
  ['/usage', 'Show neuron meter'],
  ['/workspace', 'Show workspace'],
  ['/skills', 'List skills'],
  ['/mcp', 'List MCP servers'],
  ['/tools', 'List registered tools'],
  ['/subagents', 'List subagents'],
  ['/sudo', 'Dangerously allow every tool'],
  ['/permissions', 'Show permission rules'],
  ['/plan', 'Toggle plan mode'],
  ['/copy', 'Copy session transcript'],
  ['/undo', 'Undo last change'],
  ['/paste-image', 'Paste clipboard image'],
  ['/quit', 'Exit'],
];

export const SLASH_COMMANDS = HELP_COMMANDS;

export const HELP_KEYS: [string, string][] = [
  ['Tab', 'Autocomplete'],
  ['Shift+Tab / Ctrl+P', 'Toggle plan mode'],
  ['Enter', 'Steer or Submit'],
  ['Ctrl+C', 'Interrupt / exit'],
  ['Escape', 'Clear / interrupt'],
];
