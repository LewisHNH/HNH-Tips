// netlify/functions/hnh-cron.js
//
// The scheduled trigger. This is the ONLY file with a schedule, and
// because Netlify blocks HTTP access to scheduled functions, keeping it
// separate means hnh-brief.js stays testable from your phone.
//
// netlify.toml:
//   [functions."hnh-cron"]
//     schedule = "45 5,6 * * *"

function ukHour(d) {
  const dt = d instanceof Date ? d : new Date(d || Date.now());
  return parseInt(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hour: '2-digit', hour12: false,
  }).format(dt), 10);
}

exports.handler = async () => {
  // Cron fires at 05:45 and 06:45 UTC. Only one of those is 06:45 UK,
  // so this exits on the wrong one. Survives the clock change untouched.
  const hour = ukHour();
  if (hour !== 6) {
    console.log(`hnh-cron: skipped, UK hour is ${hour}`);
    return { statusCode: 200, body: 'skipped' };
  }

  const base = process.env.URL || process.env.DEPLOY_PRIME_URL;
  const pw = process.env.ADMIN_PASSWORD;
  if (!base || !pw) {
    console.error('hnh-cron: URL or ADMIN_PASSWORD missing');
    return { statusCode: 500, body: 'config missing' };
  }

  try {
    const res = await fetch(
      `${base}/.netlify/functions/hnh-brief?pw=${encodeURIComponent(pw)}`
    );
    const body = await res.text();
    console.log(`hnh-cron: brief responded ${res.status} - ${body}`);
    return { statusCode: 200, body: `triggered: ${body}` };
  } catch (err) {
    console.error('hnh-cron failed:', err);
    return { statusCode: 500, body: err.message };
  }
};
