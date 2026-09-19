import type { CoverageResult } from '../../shared/types.js';
import { AppError, type ErrorCode } from '../errors.js';

export function appleError(text: string): ErrorCode | 'CAPTCHA_REJECTED' | null {
  if (/we[’']?ll be back|we(?:[’']re| are) busy updating our support tools/i.test(text))
    return 'APPLE_RATE_LIMITED';
  if (
    /incorrect.{0,30}(code|characters)|code.{0,40}(incorrect|doesn.t match)|characters.{0,40}(incorrect|do not match)|enter the code.{0,30}(again|correctly)/i.test(
      text,
    )
  )
    return 'CAPTCHA_REJECTED';
  if (
    /invalid serial|enter a valid serial|serial number.{0,35}(isn.t valid|is not valid|not found)/i.test(
      text,
    )
  )
    return 'SERIAL_NOT_FOUND';
  if (/activate your device|device.{0,30}(not been activated|hasn.t been activated)/i.test(text))
    return 'NOT_ACTIVATED';
  if (
    /validate.{0,25}purchase date|purchase date.{0,25}(not validated|unable to validate)/i.test(
      text,
    )
  )
    return 'PURCHASE_DATE';
  if (/access denied|too many requests|request blocked/i.test(text)) return 'APPLE_BLOCKED';
  if (
    /unable to (check|find|complete|process).{0,90}(coverage|request)|try again later|temporarily unavailable/is.test(
      text,
    )
  )
    return 'APPLE_UNAVAILABLE';
  return null;
}

export function parseCoverage(
  text: string,
  headings: string[],
  serial: string,
  now = new Date(),
): CoverageResult {
  const lines = text
    .split(/\n/)
    .map((v) => v.trim())
    .filter(Boolean);
  const model =
    headings
      .map((s) => s.trim())
      .find((s) =>
        /^(iPhone|iPad|iPod|Mac|iMac|AirPods|Apple (Watch|TV|Vision|Display)|HomePod|Beats|Studio Display|Pro Display|Magic|AirTag|Apple Pencil)/i.test(
          s,
        ),
      ) ?? null;
  const error = appleError(text);
  if (error && error !== 'CAPTCHA_REJECTED') throw new AppError(error);
  if (!model || !text.replace(/\s/g, '').toUpperCase().includes(serial))
    throw new AppError('PAGE_CHANGED');
  const coverageLabel =
    headings
      .map((s) => s.trim())
      .find((s) =>
        /^(Coverage Expired|Coverage Has Expired|Limited Warranty|AppleCare\+(?: with Theft and Loss)?|AppleCare Protection Plan|AppleCare Services)$/i.test(
          s,
        ),
      ) ?? null;
  // Only explicit coverage headings imply a status. Body links advertising AppleCare cannot imply active protection.
  const coverageStatus =
    coverageLabel && /expired/i.test(coverageLabel)
      ? 'expired'
      : coverageLabel && /^(Limited Warranty|AppleCare)/i.test(coverageLabel)
        ? 'active'
        : 'unknown';
  function field(pattern: RegExp) {
    const index = lines.findIndex((l) => pattern.test(l));
    if (index < 0) return null;
    const inline = lines[index]
      .replace(pattern, '')
      .replace(/^\s*[:–-]\s*/, '')
      .trim();
    const candidate = inline || lines[index + 1];
    return candidate && /\d{4}/.test(candidate) && candidate.length < 100 ? candidate : null;
  }
  const start = lines.findIndex((l) => l === model);
  const end = lines.findIndex(
    (l, i) => i > start && /^(Need help\?|Apple Footer|Copyright ©)/.test(l),
  );
  const details = lines.slice(Math.max(start, 0), end > start ? end : undefined);
  return {
    serial,
    model,
    coverageStatus,
    coverageLabel,
    expirationDate: field(
      /^(?:Estimated )?Expiration Date\s*:?|^Expires\s*: ?|^Expires\s+|^Expired\s+(?:on\s+)?/i,
    ),
    renewalDate: field(/^Renewal Date\s*:?|^Renews\s+(?:on\s+)?/i),
    purchaseDate: field(
      /^(?:Estimated )?Purchase Date\s*:?|^Date of Purchase\s*:?|^Purchased\s+(?:on\s+)?/i,
    ),
    details,
    rawText: details.join('\n'),
    checkedAt: now.toISOString(),
    source: 'apple',
    sourceUrl: 'https://checkcoverage.apple.com/?locale=en_US',
  };
}
