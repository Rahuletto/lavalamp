export const INPUT_STACK_ORDER = [
  'confirmBox',
  'permissionBox',
  'completionBox',
  'inputSeparatorTop',
  'inputRow',
] as const;

export type InputStackSlot = (typeof INPUT_STACK_ORDER)[number];

export type InputStackParts<T> = Record<InputStackSlot, T>;

export function orderedInputStack<T>(parts: InputStackParts<T>): T[] {
  return INPUT_STACK_ORDER.map((slot) => parts[slot]);
}

export function mountInputStack<T>(
  root: { add(part: T): unknown },
  parts: InputStackParts<T>,
): void {
  for (const part of orderedInputStack(parts)) {
    root.add(part);
  }
}
