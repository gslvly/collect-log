import { describe, expect, it } from 'vitest';

import { CaptchaService } from './captcha.js';

function decodeSvg(image: string): string {
  return Buffer.from(image.replace('data:image/svg+xml;base64,', ''), 'base64').toString('utf8');
}

describe('CaptchaService', () => {
  it('returns an SVG data URI and consumes a challenge exactly once', () => {
    const captcha = new CaptchaService(120, () => 'ABCDE');
    const challenge = captcha.create();

    expect(challenge.image).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(captcha.consume(challenge.captchaId, 'abcde')).toBe(true);
    expect(captcha.consume(challenge.captchaId, 'ABCDE')).toBe(false);
    captcha.close();
  });

  it('deletes a challenge immediately after a failed answer', () => {
    const captcha = new CaptchaService(120, () => 'ABCDE');
    const challenge = captcha.create();

    expect(captcha.consume(challenge.captchaId, 'WRONG')).toBe(false);
    expect(captcha.consume(challenge.captchaId, 'ABCDE')).toBe(false);
    captcha.close();
  });

  it('never writes the answer into the rendered SVG', () => {
    const captcha = new CaptchaService(120, () => 'ABCDE');
    const svg = decodeSvg(captcha.create().image);

    expect(svg).not.toContain('<text');
    expect(svg).not.toContain('ABCDE');
    for (const character of 'ABCDE') {
      expect(svg).not.toContain(`>${character}<`);
    }
    // 每个字符至少渲染出一条笔画，外加 24 条干扰笔画。
    expect(svg.match(/<path /g)?.length ?? 0).toBeGreaterThanOrEqual(5 + 24);
    captcha.close();
  });

  it('renders the same code differently on every challenge', () => {
    const captcha = new CaptchaService(120, () => 'ABCDE');

    expect(decodeSvg(captcha.create().image)).not.toBe(decodeSvg(captcha.create().image));
    captcha.close();
  });

  it('caps the in-memory challenge map and evicts the oldest entries first', () => {
    const captcha = new CaptchaService(120, () => 'ABCDE', Date.now, 4);
    const oldest = captcha.create();

    for (let index = 0; index < 20; index += 1) {
      captcha.create();
    }
    const newest = captcha.create();

    expect(captcha.size).toBeLessThanOrEqual(4);
    expect(captcha.consume(oldest.captchaId, 'ABCDE')).toBe(false);
    expect(captcha.consume(newest.captchaId, 'ABCDE')).toBe(true);
    captcha.close();
  });

  it('rejects expired challenges', () => {
    let now = 1_000;
    const captcha = new CaptchaService(
      1,
      () => 'ABCDE',
      () => now,
    );
    const challenge = captcha.create();
    now += 1_001;

    expect(captcha.consume(challenge.captchaId, 'ABCDE')).toBe(false);
    captcha.close();
  });
});
