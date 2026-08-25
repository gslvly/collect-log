import { randomInt, randomUUID } from 'node:crypto';

import { configuredLimits } from '../../config/limits.js';
import { GLYPH_HEIGHT, GLYPH_WIDTH, GLYPHS } from './captcha-glyphs.js';

const CAPTCHA_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CAPTCHA_LENGTH = 5;
const CANVAS_WIDTH = 180;
const CANVAS_HEIGHT = 52;
const GLYPH_ORIGIN_X = 26;
const GLYPH_ADVANCE_X = 32;
const INK_COLORS = ['#0f172a', '#1e293b', '#312e81', '#3f2d1d', '#14532d', '#4c1d3d'];
// 进程内挑战数的硬上限：/api/auth/captcha 是匿名接口，除限流外还需要内存兜底。
const MAX_ENTRIES = 5_000;

interface CaptchaEntry {
  answer: string;
  expiresAt: number;
}

interface Pen {
  color: string;
  width: number;
  opacity: number;
}

type Point = readonly [number, number];

export interface CaptchaChallenge {
  captchaId: string;
  image: string;
}

export type CaptchaCodeFactory = () => string;

function randomCode(): string {
  return Array.from(
    { length: CAPTCHA_LENGTH },
    () => CAPTCHA_ALPHABET[randomInt(CAPTCHA_ALPHABET.length)],
  ).join('');
}

function randomBetween(min: number, max: number): number {
  return min + (randomInt(1_001) * (max - min)) / 1_000;
}

function randomInk(): string {
  return INK_COLORS[randomInt(INK_COLORS.length)] ?? '#0f172a';
}

function toPath(points: readonly Point[], pen: Pen): string {
  const commands = points
    .map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(' ');
  return `<path d="${commands}" fill="none" stroke="${pen.color}" stroke-width="${pen.width.toFixed(1)}" stroke-opacity="${pen.opacity.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

// 字形笔画被烘焙成绝对坐标：每次渲染的缩放、旋转和逐点抖动都不同，
// 因此 path 的 d 值无法反查字形表，SVG 里也不存在答案的明文形式。
function glyphPaths(character: string, centerX: number): string[] {
  const strokes = GLYPHS[character];
  if (strokes === undefined) {
    return [];
  }

  const scaleX = randomBetween(2.1, 2.5);
  const scaleY = randomBetween(2.3, 2.7);
  const rotation = randomBetween(-0.26, 0.26);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const centerY = CANVAS_HEIGHT / 2 + randomBetween(-2, 2);
  const pen: Pen = {
    color: randomInk(),
    width: randomBetween(2.4, 3.2),
    opacity: randomBetween(0.85, 1),
  };

  return strokes.map((stroke) =>
    toPath(
      stroke.map(([gridX, gridY]): Point => {
        const localX = (gridX - GLYPH_WIDTH / 2) * scaleX + randomBetween(-0.7, 0.7);
        const localY = (gridY - GLYPH_HEIGHT / 2) * scaleY + randomBetween(-0.7, 0.7);
        return [
          centerX + localX * cos - localY * sin,
          centerY + localX * sin + localY * cos,
        ] as const;
      }),
      pen,
    ),
  );
}

// 干扰笔画与字形笔画同构（同样是折线 path、相近的线宽与配色），
// 无法靠属性差异被批量剔除。
function crossingNoise(count: number): string[] {
  return Array.from({ length: count }, () => {
    const points = Array.from({ length: 4 }, (): Point => [
      randomBetween(-6, CANVAS_WIDTH + 6),
      randomBetween(-4, CANVAS_HEIGHT + 4),
    ]);
    return toPath(points, {
      color: randomInk(),
      width: randomBetween(0.9, 1.7),
      opacity: randomBetween(0.5, 0.8),
    });
  });
}

function speckNoise(count: number): string[] {
  return Array.from({ length: count }, () => {
    const x = randomBetween(4, CANVAS_WIDTH - 4);
    const y = randomBetween(4, CANVAS_HEIGHT - 4);
    const points: Point[] = [
      [x, y],
      [x + randomBetween(-2.5, 2.5), y + randomBetween(-2.5, 2.5)],
    ];
    return toPath(points, {
      color: randomInk(),
      width: randomBetween(1.2, 2.4),
      opacity: randomBetween(0.55, 0.9),
    });
  });
}

// 打乱输出顺序，使 path 的书写顺序不再对应字符顺序。
function shuffle(values: string[]): string[] {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapWith = randomInt(index + 1);
    const current = values[index];
    const other = values[swapWith];
    if (current !== undefined && other !== undefined) {
      values[index] = other;
      values[swapWith] = current;
    }
  }
  return values;
}

function renderSvg(code: string): string {
  const glyphs = [...code].flatMap((character, index) =>
    glyphPaths(character, GLYPH_ORIGIN_X + index * GLYPH_ADVANCE_X),
  );
  // 大部分干扰垫在字符下层，保证人眼可读；字形笔画之间仍然打乱，
  // path 的书写顺序因此不对应字符顺序。
  const body = [
    ...crossingNoise(4),
    ...speckNoise(10),
    ...shuffle(glyphs),
    ...crossingNoise(2),
    ...speckNoise(8),
  ].join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" viewBox="0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}"><rect width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" rx="6" fill="#e2e8f0"/>${body}</svg>`;
}

export class CaptchaService {
  readonly #entries = new Map<string, CaptchaEntry>();
  readonly #cleanupTimer: NodeJS.Timeout;

  constructor(
    private readonly ttlSec = configuredLimits.auth.captchaTtlSec,
    private readonly codeFactory: CaptchaCodeFactory = randomCode,
    private readonly now: () => number = Date.now,
    private readonly maxEntries = MAX_ENTRIES,
  ) {
    const cleanupEveryMs = Math.min(ttlSec * 1_000, 60_000);
    this.#cleanupTimer = setInterval(() => this.cleanupExpired(), cleanupEveryMs);
    this.#cleanupTimer.unref();
  }

  get size(): number {
    return this.#entries.size;
  }

  create(): CaptchaChallenge {
    this.evictOverflow();

    const captchaId = randomUUID();
    const answer = this.codeFactory().toUpperCase();
    this.#entries.set(captchaId, {
      answer,
      expiresAt: this.now() + this.ttlSec * 1_000,
    });
    const image = `data:image/svg+xml;base64,${Buffer.from(renderSvg(answer)).toString('base64')}`;
    return { captchaId, image };
  }

  consume(captchaId: string, submittedCode: string): boolean {
    const entry = this.#entries.get(captchaId);
    this.#entries.delete(captchaId);

    return (
      entry !== undefined &&
      entry.expiresAt > this.now() &&
      submittedCode.trim().toUpperCase() === entry.answer
    );
  }

  close(): void {
    clearInterval(this.#cleanupTimer);
    this.#entries.clear();
  }

  private cleanupExpired(): void {
    const now = this.now();
    for (const [captchaId, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(captchaId);
      }
    }
  }

  // 先清过期项，仍然超限时按插入序淘汰最旧的挑战。
  private evictOverflow(): void {
    if (this.#entries.size < this.maxEntries) {
      return;
    }

    this.cleanupExpired();
    while (this.#entries.size >= this.maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.#entries.delete(oldest.value);
    }
  }
}
