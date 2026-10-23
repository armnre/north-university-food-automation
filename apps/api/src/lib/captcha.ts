import { randomInt } from 'node:crypto';
import { toPersianDigits } from '@food/shared';

/**
 * کپچای ساختِ خود سامانه (بدون وابستگی به سرویس بیرونی).
 *
 *  - نوع ریاضی: «۷ + ۵ = ؟» با نویز تصویری
 *  - نوع متنی: ۴ کاراکتر بدون ارقام مبهم
 * خروجی یک SVG است؛ فقط hash پاسخ در دیتابیس ذخیره می‌شود (یک‌بارمصرف).
 */

export type CaptchaKind = 'Math' | 'Text';

export type CaptchaChallenge = { kind: CaptchaKind; answer: string; imageSvg: string };

const TEXT_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function createCaptcha(kind: CaptchaKind = 'Math'): CaptchaChallenge {
  return kind === 'Math' ? createMathCaptcha() : createTextCaptcha();
}

function createMathCaptcha(): CaptchaChallenge {
  const ops = ['+', '-', '×'] as const;
  const op = ops[randomInt(0, ops.length)] ?? '+';
  let a = randomInt(2, 12);
  let b = randomInt(2, 12);
  if (op === '-' && b > a) [a, b] = [b, a];
  if (op === '×') {
    a = randomInt(2, 9);
    b = randomInt(2, 9);
  }
  const answer = String(op === '+' ? a + b : op === '-' ? a - b : a * b);
  const prompt = `${toPersianDigits(a)} ${op === '×' ? '×' : op} ${toPersianDigits(b)} = ؟`;
  return { kind: 'Math', answer, imageSvg: renderSvg(prompt) };
}

function createTextCaptcha(): CaptchaChallenge {
  let text = '';
  for (let i = 0; i < 4; i += 1) text += TEXT_ALPHABET[randomInt(0, TEXT_ALPHABET.length)];
  return { kind: 'Text', answer: text, imageSvg: renderSvg(text, { letterSpacing: 8 }) };
}

/** نرمال‌سازی پاسخ کاربر: ارقام فارسی/عربی → ASCII، حذف فاصله. */
export function normalizeCaptchaAnswer(input: string): string {
  return String(input ?? '')
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[\s\u200c]/g, '')
    .trim();
}

type RenderOptions = { letterSpacing?: number };

/**
 * رندر SVG ساده با نویز (خط‌های تصادفی و چرخش جزئی متن) تا خواندن ماشینی
 * آسان نباشد؛ بدون نیاز به فونت یا کتابخانهٔ تصویر.
 */
function renderSvg(prompt: string, options: RenderOptions = {}): string {
  const width = 200;
  const height = 70;
  const letterSpacing = options.letterSpacing ?? 4;
  const noise: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const x1 = randomInt(0, width);
    const y1 = randomInt(0, height);
    const x2 = randomInt(0, width);
    const y2 = randomInt(0, height);
    noise.push(
      `<path d="M${x1} ${y1} Q ${(x1 + x2) / 2} ${(y1 + y2) / 2 + randomInt(-14, 14)} ${x2} ${y2}" stroke="#94a3b8" stroke-opacity="0.55" fill="none" stroke-width="${randomInt(1, 3)}"/>`,
    );
  }
  const dots: string[] = [];
  for (let i = 0; i < 40; i += 1) {
    dots.push(
      `<circle cx="${randomInt(0, width)}" cy="${randomInt(0, height)}" r="${randomInt(1, 3)}" fill="#cbd5e1" fill-opacity="0.7"/>`,
    );
  }

  // هر کاراکتر با چرخش و جابه‌جایی عمودی کمی متفاوت
  const chars = [...prompt];
  const totalWidth = chars.length * (18 + letterSpacing);
  const startX = Math.max(12, (width - totalWidth) / 2);
  const glyphs = chars
    .map((ch, i) => {
      const x = startX + i * (18 + letterSpacing) + randomInt(-2, 3);
      const y = 44 + randomInt(-4, 5);
      const rotate = randomInt(-14, 15);
      return `<text x="${x}" y="${y}" font-size="26" font-family="Tahoma, 'DejaVu Sans', sans-serif" fill="#0f172a" transform="rotate(${rotate} ${x} ${y})">${escapeXml(ch)}</text>`;
    })
    .join('');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="کد امنیتی">`,
    `<rect width="${width}" height="${height}" rx="12" fill="#f8fafc" stroke="#e2e8f0"/>`,
    ...noise,
    ...dots,
    glyphs,
    `</svg>`,
  ].join('');
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case "'":
        return '&apos;';
      default:
        return '&quot;';
    }
  });
}
