'use client';
import type { ShareableMonth } from './month-share';

/** Draws the square "my month on TipMe" image from shareable data only (the week card's style). */
export function drawMonthCard(
  canvas: HTMLCanvasElement,
  month: ShareableMonth,
  /** ' · test mode' on a test copy, empty otherwise (see paymentModeCopy). */
  handleSuffix: string,
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
  ctx.fillText(`tipme ♥ · ${month.monthName}`, x, size * 0.14);
  ctx.font = `700 ${Math.round(size * 0.11)}px Arial, sans-serif`;
  ctx.fillText(
    month.total ?? `${month.tipCount} ${month.tipCount === 1 ? 'tip' : 'tips'}`,
    x,
    size * 0.34,
  );
  ctx.font = `400 ${Math.round(size * 0.045)}px Arial, sans-serif`;
  const lines = [
    month.total
      ? `${month.tipCount} ${month.tipCount === 1 ? 'tip' : 'tips'}`
      : 'of appreciation',
    month.bestWeek ? `Best week: ${month.bestWeek}` : null,
    month.bestDay ? `Most tips on ${month.bestDay}` : null,
  ].filter((line): line is string => line !== null);
  lines.forEach((line, index) => {
    ctx.fillText(line, x, size * (0.43 + index * 0.07));
  });
  ctx.font = `700 ${Math.round(size * 0.055)}px Arial, sans-serif`;
  ctx.fillText(month.displayName, x, size * 0.84);
  ctx.font = `400 ${Math.round(size * 0.04)}px Arial, sans-serif`;
  ctx.fillText(`@${month.handle}${handleSuffix}`, x, size * 0.9);
}
