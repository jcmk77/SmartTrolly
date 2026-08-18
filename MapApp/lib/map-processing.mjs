/**
 * Convert grayscale map pixels into a binary ROS occupancy image.
 * Pixels at or above the cutoff are white/free; darker pixels are black/walls.
 *
 * @param {Uint8Array} grayscalePixels
 * @param {number} whiteCutoff
 * @returns {Uint8Array}
 */
export function binarizePixels(grayscalePixels, whiteCutoff) {
  if (!Number.isInteger(whiteCutoff) || whiteCutoff < 1 || whiteCutoff > 255) {
    throw new RangeError("White cutoff must be a whole number from 1 to 255.");
  }

  const occupancyPixels = new Uint8Array(grayscalePixels.length);
  for (let index = 0; index < grayscalePixels.length; index += 1) {
    occupancyPixels[index] = grayscalePixels[index] >= whiteCutoff ? 255 : 0;
  }

  return occupancyPixels;
}
