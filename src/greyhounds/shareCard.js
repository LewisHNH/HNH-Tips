import { formatOdds, fmtPts } from './points.js';
import { SITE_URL } from './config.js';

const W = 1080;
const H = 1350;

const gold = (ctx, x0, y0, x1, y1) => {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, '#B8862B');
  g.addColorStop(0.35, '#F0D98C');
  g.addColorStop(0.6, '#FBF3D0');
  g.addColorStop(0.85, '#D4AF37');
  g.addColorStop(1, '#A8781F');
  return g;
};

function tracked(ctx, text, x, y, spacing, align = 'center') {
  const chars = [...text];
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
  let cursor = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  chars.forEach((c, i) => {
    ctx.fillText(c, cursor, y);
    cursor += widths[i] + spacing;
  });
  return total;
}

/**
 * Draw the free tip of the day as a branded 1080x1350 image.
 * Returns a Blob.
 */
export async function buildShareCard(tip, { subtitle = 'FREE TIP OF THE DAY' } = {}) {
  if (document.fonts && document.fonts.ready) {
    try {
      await document.fonts.load('700 64px Montserrat');
      await document.fonts.ready;
    } catch {
      /* fall back to system sans */
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, W, H);

  // Faint vignette so the gold reads on screen
  const vig = ctx.createRadialGradient(W / 2, H * 0.42, 80, W / 2, H * 0.42, H * 0.7);
  vig.addColorStop(0, 'rgba(212,175,55,0.10)');
  vig.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // Masthead
  ctx.font = '800 46px Montserrat, Arial, sans-serif';
  ctx.fillStyle = gold(ctx, 300, 120, 780, 190);
  tracked(ctx, 'HOOVES & HOUNDS', W / 2, 150, 8);

  // "— BY —" divider device
  ctx.font = '600 20px Montserrat, Arial, sans-serif';
  ctx.fillStyle = 'rgba(212,175,55,0.65)';
  tracked(ctx, '— GREYHOUNDS —', W / 2, 196, 6);

  // Eyebrow
  ctx.font = '700 24px Montserrat, Arial, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  tracked(ctx, subtitle, W / 2, 300, 9);

  // Trap number — the signature element
  const trapY = 520;
  ctx.strokeStyle = gold(ctx, W / 2 - 120, trapY - 120, W / 2 + 120, trapY + 40);
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(W / 2, trapY - 46, 118, 0, Math.PI * 2);
  ctx.stroke();

  ctx.font = '800 150px Montserrat, Arial, sans-serif';
  ctx.fillStyle = gold(ctx, W / 2 - 90, trapY - 140, W / 2 + 90, trapY);
  ctx.textAlign = 'center';
  ctx.fillText(String(tip.trap ?? '?'), W / 2, trapY);
  ctx.font = '700 20px Montserrat, Arial, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.textAlign = 'left';
  tracked(ctx, 'TRAP', W / 2, trapY + 60, 7);

  // Dog name
  ctx.textAlign = 'center';
  let size = 76;
  ctx.font = `800 ${size}px Montserrat, Arial, sans-serif`;
  const name = (tip.dog || '').toUpperCase();
  while (ctx.measureText(name).width > W - 160 && size > 34) {
    size -= 4;
    ctx.font = `800 ${size}px Montserrat, Arial, sans-serif`;
  }
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(name, W / 2, 720);

  // Track + time
  ctx.textAlign = 'left';
  ctx.font = '600 30px Montserrat, Arial, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  tracked(ctx, `${(tip.track || '').toUpperCase()}  ·  ${tip.time || ''}`, W / 2, 780, 5);

  // Odds + stake block
  const boxY = 860;
  ctx.strokeStyle = 'rgba(212,175,55,0.35)';
  ctx.lineWidth = 2;
  ctx.strokeRect(90, boxY, W - 180, 190);

  ctx.font = '700 22px Montserrat, Arial, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  tracked(ctx, 'ADVISED', W * 0.32, boxY + 62, 6);
  tracked(ctx, 'STAKE', W * 0.68, boxY + 62, 6);

  ctx.font = '800 62px Montserrat, Arial, sans-serif';
  ctx.fillStyle = gold(ctx, 200, boxY + 80, 880, boxY + 150);
  ctx.textAlign = 'center';
  ctx.fillText(formatOdds(tip.oddsAdvised), W * 0.32, boxY + 140);
  ctx.fillText(`${Number(tip.points) || 1} PT`, W * 0.68, boxY + 140);

  // Footer
  ctx.textAlign = 'left';
  ctx.font = '700 26px Montserrat, Arial, sans-serif';
  ctx.fillStyle = gold(ctx, 300, 1150, 780, 1190);
  tracked(ctx, SITE_URL.toUpperCase(), W / 2, 1180, 7);

  ctx.font = '600 19px Montserrat, Arial, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  tracked(ctx, '18+  ·  BEGAMBLEAWARE.ORG  ·  BET RESPONSIBLY', W / 2, 1240, 3);

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/**
 * Draw a settled result as a branded 1080x1350 image.
 * `profit` is points won/lost on the day, `running` the cumulative total.
 */
export async function buildResultCard(tip, { profit = 0, running = 0 } = {}) {
  if (document.fonts && document.fonts.ready) {
    try {
      await document.fonts.load('800 64px Montserrat');
      await document.fonts.ready;
    } catch {
      /* fall back to system sans */
    }
  }

  const won = tip.result === 'win';
  const voided = tip.result === 'void';
  const accent = won ? '#7BE0A4' : voided ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.65)';

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, W, H);

  const vig = ctx.createRadialGradient(W / 2, H * 0.4, 80, W / 2, H * 0.4, H * 0.7);
  vig.addColorStop(0, won ? 'rgba(76,187,120,0.13)' : 'rgba(212,175,55,0.08)');
  vig.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = 'left';

  // Masthead
  ctx.font = '800 46px Montserrat, Arial, sans-serif';
  ctx.fillStyle = gold(ctx, 300, 120, 780, 190);
  tracked(ctx, 'HOOVES & HOUNDS', W / 2, 150, 8);
  ctx.font = '600 20px Montserrat, Arial, sans-serif';
  ctx.fillStyle = 'rgba(212,175,55,0.65)';
  tracked(ctx, '— GREYHOUNDS —', W / 2, 196, 6);

  // Outcome
  ctx.font = '800 40px Montserrat, Arial, sans-serif';
  ctx.fillStyle = accent;
  tracked(ctx, won ? 'WINNER' : voided ? 'VOID' : 'NO LUCK', W / 2, 330, 12);

  // Day's points — the hero
  if (!voided) {
    ctx.textAlign = 'center';
    ctx.font = '800 190px Montserrat, Arial, sans-serif';
    ctx.fillStyle = won ? gold(ctx, W / 2 - 220, 380, W / 2 + 220, 520) : 'rgba(255,255,255,0.28)';
    ctx.fillText(fmtPts(profit), W / 2, 500);
    ctx.textAlign = 'left';
    ctx.font = '700 22px Montserrat, Arial, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    tracked(ctx, 'POINTS ON THE DAY', W / 2, 548, 8);
  }

  // The selection
  ctx.textAlign = 'center';
  let size = 68;
  ctx.font = `800 ${size}px Montserrat, Arial, sans-serif`;
  const name = (tip.dog || '').toUpperCase();
  while (ctx.measureText(name).width > W - 160 && size > 32) {
    size -= 4;
    ctx.font = `800 ${size}px Montserrat, Arial, sans-serif`;
  }
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(name, W / 2, voided ? 560 : 700);

  ctx.textAlign = 'left';
  ctx.font = '600 28px Montserrat, Arial, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  tracked(
    ctx,
    `TRAP ${tip.trap}  ·  ${(tip.track || '').toUpperCase()}  ·  ${formatOdds(tip.oddsAdvised)}`,
    W / 2,
    voided ? 615 : 755,
    4
  );

  // Running total
  const boxY = 860;
  ctx.strokeStyle = 'rgba(212,175,55,0.35)';
  ctx.lineWidth = 2;
  ctx.strokeRect(90, boxY, W - 180, 175);

  ctx.font = '700 22px Montserrat, Arial, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  tracked(ctx, 'FREE TIPS RUNNING TOTAL', W / 2, boxY + 58, 7);

  ctx.textAlign = 'center';
  ctx.font = '800 76px Montserrat, Arial, sans-serif';
  ctx.fillStyle = gold(ctx, 250, boxY + 80, 830, boxY + 150);
  ctx.fillText(`${fmtPts(running)} PTS`, W / 2, boxY + 135);

  // Footer
  ctx.textAlign = 'left';
  ctx.font = '700 26px Montserrat, Arial, sans-serif';
  ctx.fillStyle = gold(ctx, 300, 1150, 780, 1190);
  tracked(ctx, SITE_URL.toUpperCase(), W / 2, 1180, 7);
  ctx.font = '600 19px Montserrat, Arial, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  tracked(ctx, '18+  ·  BEGAMBLEAWARE.ORG  ·  BET RESPONSIBLY', W / 2, 1240, 3);

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/** Share a settled result via the native sheet, or download it. */
export async function shareResult(tip, totals) {
  const blob = await buildResultCard(tip, totals);
  const file = new File([blob], `hnh-${tip.date}-result.png`, { type: 'image/png' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    await navigator.share({
      files: [file],
      title: 'Hooves & Hounds — greyhound result',
      text: `${tip.dog} · ${tip.result === 'win' ? 'Winner' : 'Result'} · ${tip.track}`,
    });
    return 'shared';
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.click();
  URL.revokeObjectURL(url);
  return 'downloaded';
}

/** Share via the native sheet where available, otherwise download. */
export async function shareTip(tip, options) {
  const blob = await buildShareCard(tip, options);
  const file = new File([blob], `hnh-${tip.date}-trap-${tip.trap}.png`, { type: 'image/png' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    await navigator.share({
      files: [file],
      title: 'Hooves & Hounds — free greyhound tip',
      text: `${tip.dog} · Trap ${tip.trap} · ${tip.track} ${tip.time}`,
    });
    return 'shared';
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.click();
  URL.revokeObjectURL(url);
  return 'downloaded';
}
