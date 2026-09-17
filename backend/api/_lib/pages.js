/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Small server-rendered pages — for the links in emails.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * These pages handle one-time tokens, so they are locked down:
 *
 *   • every dynamic value is HTML-escaped;
 *   • no scripts, images or outside resources at all (the Content-Security-Policy
 *     allows inline styles and nothing else), so the token in the URL cannot
 *     leak through a Referer header or a third-party request;
 *   • they cannot be framed, cached, or indexed.
 */

const APP_NAME = process.env.APP_NAME || 'AI Influencer'

export const escapeHtml = value =>
  String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const STYLE = `
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
    background:#f6f6f8;color:#1d1d1f;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
  main{width:100%;max-width:420px;background:#fff;border-radius:14px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  h1{font-size:22px;margin:0 0 12px}
  p{margin:0 0 16px;line-height:1.5;color:#3a3a3c}
  label{display:block;font-size:14px;font-weight:600;margin:0 0 6px}
  input{width:100%;font-size:16px;padding:12px;border:1px solid #c7c7cc;border-radius:8px;margin:0 0 16px}
  button,.button{display:block;width:100%;text-align:center;font-size:16px;font-weight:600;padding:13px;border:0;
    border-radius:8px;background:#6d4aff;color:#fff;text-decoration:none;cursor:pointer}
  .error{background:#fdecec;color:#b3261e;border-radius:8px;padding:12px;margin:0 0 16px}
  .hint{font-size:13px;color:#6e6e73;margin:-8px 0 16px}
  .muted{font-size:13px;color:#6e6e73;margin-top:16px}
  @media (prefers-color-scheme: dark){
    body{background:#000;color:#f5f5f7} main{background:#1c1c1e;box-shadow:none} p{color:#d1d1d6}
    input{background:#2c2c2e;color:#f5f5f7;border-color:#48484a} .hint,.muted{color:#98989d}
  }
`

/**
 * @param {object} res
 * @param {{status?: number, title: string, body: string}} page  `body` is HTML
 *        the caller has already escaped
 */
export function sendPage(res, { status = 200, title, body }) {
  res.status(status)
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  )
  res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)} — ${escapeHtml(APP_NAME)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`)
}

/** Opens the app on a phone that has it installed. */
export function openAppLink() {
  const url = process.env.APP_OPEN_URL || 'aiinfluencer://'
  return `<a class="button" href="${escapeHtml(url)}">Open the app</a>
<p class="muted">On a computer? Open ${escapeHtml(APP_NAME)} on your phone and sign in there.</p>`
}
