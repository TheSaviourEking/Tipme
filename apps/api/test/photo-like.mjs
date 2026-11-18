import sharp from 'sharp';

// A generated photo for size measurements: never a real person's photo (the repository is public).
// A sky gradient, thousands of hard-edged shapes at many scales, a slight blur and sensor-like
// grain, saved as a camera would (JPEG, quality 88). Its 2240×600 cover is about 100 KB, near the
// 132 KB of the real photo measured in the lab (Studio styles spec §9.9). Deterministic: a seed.
export async function photoLike({
  width = 2400,
  height = 1600,
  shapes = 6000,
  seed = 7,
} = {}) {
  let state = seed;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  let body = '';
  for (let i = 0; i < shapes; i += 1) {
    const size = random() ** 3 * 300 + 4;
    const x = random() * width;
    const y = random() * height;
    const fill = `rgb(${Math.floor(random() * 200 + 30)},${Math.floor(random() * 180 + 40)},${Math.floor(random() * 160 + 40)})`;
    const opacity = (0.4 + random() * 0.6).toFixed(2);
    body +=
      random() < 0.5
        ? `<rect x="${x}" y="${y}" width="${size}" height="${size * (0.3 + random() * 2)}" fill="${fill}" opacity="${opacity}" transform="rotate(${random() * 40 - 20} ${x} ${y})"/>`
        : `<circle cx="${x}" cy="${y}" r="${size / 2}" fill="${fill}" opacity="${opacity}"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6a9fd8"/><stop offset="1" stop-color="#e8c79a"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>${body}</svg>`;
  const { data, info } = await sharp(Buffer.from(svg))
    .blur(1.2)
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 1)
    data[i] = Math.max(0, Math.min(255, data[i] + (random() - 0.5) * 22));
  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  })
    .jpeg({ quality: 88 })
    .toBuffer();
}
