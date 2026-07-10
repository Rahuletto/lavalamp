export interface AttachedImage {
  path: string;
  tag: string;
}

export function attachmentsForPrompt(
  prompt: string,
  attachments: readonly AttachedImage[],
): AttachedImage[] {
  return attachments.filter((attachment) => prompt.includes(attachment.tag));
}
