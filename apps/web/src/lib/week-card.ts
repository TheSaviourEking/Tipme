'use client';
import type { ShareableWeek } from './week-share';

/** Draws the square "my week on TipMe" image from shareable data only. */
export function drawWeekCard(
  canvas: HTMLCanvasElement,
  week: ShareableWeek,
  size = 1080,
): void {
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const g = ctx.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, '#7a32f9');
  g.addColorStop(1, '#2b0a5c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  const x = size * 0.08;
  ctx.font = `600 ${Math.round(size * 0.04)}px Arial, sans-serif`;
  ctx.fillText(`tipme ♥ · ${week.week}`, x, size * 0.14);
  ctx.font = `700 ${Math.round(size * 0.11)}px Arial, sans-serif`;
  ctx.fillText(week.total, x, size * 0.34);
  ctx.font = `400 ${Math.round(size * 0.045)}px Arial, sans-serif`;
  ctx.fillText(
    `${week.tipCount} ${week.tipCount === 1 ? 'tip' : 'tips'}${week.changeText ? ` · ${week.changeText}` : ''}`,
    x,
    size * 0.43,
  );
  week.moments.forEach((moment, index) => {
    ctx.fillText(`✳ ${moment}`, x, size * (0.56 + index * 0.07));
  });
  ctx.font = `700 ${Math.round(size * 0.055)}px Arial, sans-serif`;
  ctx.fillText(week.displayName, x, size * 0.84);
  ctx.font = `400 ${Math.round(size * 0.04)}px Arial, sans-serif`;
  ctx.fillText(`@${week.handle} · pretend payments`, x, size * 0.9);
}
