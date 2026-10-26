'use client';

const MAX_BYTES = 400_000;
const WIDTH = 960;
const HEIGHT = 1200;

/**
 * Turns a chosen photo into the page's portrait: centre-cropped to 4:5, at most 960×1200, as
 * WebP. Drawing through a canvas drops every metadata field (camera, GPS) of the original,
 * which never leaves the device.
 */
export async function preparePhoto(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/'))
    throw new Error(
      'Choose a photo (JPEG, PNG, WebP or HEIC your browser can open).',
    );
  const image = await createImageBitmap(file, {
    imageOrientation: 'from-image',
  }).catch(() => {
    throw new Error('We couldn’t open that photo. Try another one.');
  });
  const target = WIDTH / HEIGHT;
  const crop =
    image.width / image.height > target
      ? { w: image.height * target, h: image.height }
      : { w: image.width, h: image.width / target };
  const scale = Math.min(1, WIDTH / crop.w);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(crop.w * scale);
  canvas.height = Math.round(crop.h * scale);
  canvas
    .getContext('2d')!
    .drawImage(
      image,
      (image.width - crop.w) / 2,
      (image.height - crop.h) / 2,
      crop.w,
      crop.h,
      0,
      0,
      canvas.width,
      canvas.height,
    );
  image.close();
  for (const quality of [0.85, 0.7, 0.55, 0.4]) {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/webp', quality),
    );
    if (!blob || blob.type !== 'image/webp')
      throw new Error(
        'This browser can’t prepare photos. Please try another browser.',
      );
    if (blob.size <= MAX_BYTES) return blob;
  }
  throw new Error('That photo is too detailed to fit. Try a simpler one.');
}
