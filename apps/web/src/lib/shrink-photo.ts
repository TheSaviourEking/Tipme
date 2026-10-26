// Profile photos are shrunk in the browser before upload (PR-013 review): a phone photo of
// 3–8 MB becomes about 200 KB, so it uploads in seconds on a slow mobile connection. The server
// still re-encodes whatever arrives; this only saves the person's data and time.

/** The size that fits within `max` on the longest side, never larger than the original. */
export function fitWithin(
  width: number,
  height: number,
  max: number,
): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * A JPEG at most 1024 px on its longest side. If the browser cannot decode the file, the file
 * is sent as it is and the server decides (it refuses anything that is not a real photo).
 */
export async function shrinkPhoto(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = fitWithin(bitmap.width, bitmap.height, 1024);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.85),
    );
    return blob ?? file;
  } catch {
    return file;
  }
}
