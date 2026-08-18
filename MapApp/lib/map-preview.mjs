/**
 * Return whether a cleanup mask explicitly marks one pixel.
 *
 * Missing masks and out-of-range indices are intentionally treated as clear.
 * This keeps an absent suggestion overlay from being painted as a candidate.
 */
export function isMaskPixelSet(mask, index) {
  return (mask?.[index] ?? 0) !== 0;
}
