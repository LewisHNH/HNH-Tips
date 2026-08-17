// Every setting for the greyhound module lives here.
// Nothing secret belongs in this file — it ships to the browser.
// Secrets (admin token, Telegram bot token) go in Netlify environment variables.

/** Exclusive Greyhound Group checkout. */
export const WHOP_URL = 'https://whop.com/checkout/plan_ycksZsqcjlI0h';

/** Free greyhound Telegram channel. */
export const TELEGRAM_URL = 'https://t.me/+p41Yf57cWj0zNmRk';

/** Shown on the paid CTA. */
export const GROUP_PRICE = '£34.99/month';

/** The pitch line on the paid CTA. Keep it honest against the record above it. */
export const GROUP_PITCH = 'One selection a day — the single best bet on the card';

/** Who runs the paid group. Shown above the CTA. */
export const GROUP_TEAM =
  'Run by three of us — me and two of the best greyhound judges I know. ' +
  'One selection a day, agreed between us.';

/** Intro offer. Set PROMO_CODE to an empty string to hide the whole panel. */
export const PROMO_CODE = 'NEWMEMBER';
export const PROMO_TEXT = '50% off your first month';

/** The promo block appended to a group winner shout on Telegram. */
export const SHOUT_PITCH =
  'One selection a day from three of us, priced before the market moves.';

/** Used on share cards and in Telegram messages. */
export const SITE_URL = 'tips.hoovesnhounds.com';

/** Deep link to the greyhound section, for social bios. */
export const GREYHOUNDS_URL = 'https://tips.hoovesnhounds.com/#greyhounds';
