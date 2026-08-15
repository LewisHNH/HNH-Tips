// Every setting for the greyhound module lives here.
// Nothing secret belongs in this file — it ships to the browser.
// Secrets (admin token, Telegram bot token) go in Netlify environment variables.

/** Exclusive Greyhound Group checkout. */
export const WHOP_URL = 'https://whop.com/checkout/plan_ycksZsqcjlI0h';

/** Free greyhound Telegram channel. */
export const TELEGRAM_URL = 'https://t.me/+WE5lad309P1kMzY0';

/** Shown on the paid CTA. */
export const GROUP_PRICE = '£34.99/month';

/** Used on share cards and in Telegram messages. */
export const SITE_URL = 'tips.hoovesnhounds.com';

/** Deep link to the greyhound section, for social bios. */
export const GREYHOUNDS_URL = 'https://tips.hoovesnhounds.com/#greyhounds';
