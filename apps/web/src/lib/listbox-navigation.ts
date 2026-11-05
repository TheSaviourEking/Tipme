/** The next active option index, or -1 for none. `count` options, `current` -1 when none is active. */
export function nextActive(
  current: number,
  key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End',
  count: number,
): number {
  if (count <= 0) return -1;
  switch (key) {
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    // No wrap, so a screen reader never jumps from the end back to the top.
    case 'ArrowDown':
      return Math.min(current + 1, count - 1);
    case 'ArrowUp':
      return Math.max(current - 1, 0);
  }
}
