/** True when a key press is going into a text field, so single-key shortcuts should stay quiet. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el?.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]')
}
