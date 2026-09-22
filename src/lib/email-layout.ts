export const escapeHtml = (value: unknown) =>
  String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');

const TONES = {
  blue: { bg: '#eff6ff', border: '#93c5fd', label: '#1d4ed8' },
  green: { bg: '#f0fdf4', border: '#86efac', label: '#15803d' },
  amber: { bg: '#fffbeb', border: '#fcd34d', label: '#b45309' },
} as const;

const BADGES = {
  green: { bg: '#f0fdf4', color: '#15803d' },
  amber: { bg: '#fffbeb', color: '#b45309' },
  red: { bg: '#fef2f2', color: '#b91c1c' },
} as const;

export function renderEmailLayout(options: { preheader?: string; bodyHtml: string; supportEmail?: string; supportPhone?: string }) {
  const supportEmail = options.supportEmail || 'conny@gracelandvenues.co.za';
  const supportPhone = options.supportPhone || '072 264 4009';
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  </head>
  <body style="margin:0;padding:0;background-color:#eef2f7;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
    ${options.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(options.preheader)}</div>` : ''}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#eef2f7;padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background-color:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 10px rgba(15,23,42,0.08);">
            <tr>
              <td style="background:linear-gradient(135deg,#0EA5E9,#0369a1);padding:30px 32px;text-align:center;">
                <p style="margin:0;font-size:22px;font-weight:800;color:#ffffff;letter-spacing:0.5px;">GRACELAND VENUES</p>
                <p style="margin:6px 0 0;font-size:11px;font-weight:600;color:#e0f2fe;text-transform:uppercase;letter-spacing:2px;">Waterpark &amp; Event Venue</p>
              </td>
            </tr>
            <tr>
              <td style="padding:36px 32px;color:#0f172a;font-size:15px;line-height:1.65;">
                ${options.bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="background-color:#f8fafc;padding:22px 32px;text-align:center;border-top:1px solid #e2e8f0;">
                <p style="margin:0;font-size:12px;color:#64748b;">Questions? Contact us at <a href="mailto:${escapeHtml(supportEmail)}" style="color:#0EA5E9;text-decoration:none;">${escapeHtml(supportEmail)}</a> or ${escapeHtml(supportPhone)}</p>
                <p style="margin:8px 0 0;font-size:11px;color:#94a3b8;">&copy; ${new Date().getFullYear()} Graceland Venues. This email relates to a booking made on our website.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/** value must already be HTML-safe (escape before passing). */
export function calloutBox(options: { label: string; value: string; tone?: keyof typeof TONES }) {
  const tone = TONES[options.tone || 'blue'];
  return `<div style="background:${tone.bg};border:1px solid ${tone.border};border-radius:10px;padding:18px;text-align:center;margin:20px 0;">
    <p style="margin:0;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${tone.label};">${escapeHtml(options.label)}</p>
    <p style="margin:8px 0 0;font-size:26px;font-weight:800;letter-spacing:1px;color:#0f172a;">${options.value}</p>
  </div>`;
}

export function statusBadge(label: string, tone: keyof typeof BADGES = 'green') {
  const { bg, color } = BADGES[tone];
  return `<div style="display:inline-block;background:${bg};color:${color};font-size:12px;font-weight:700;letter-spacing:0.5px;padding:5px 12px;border-radius:999px;margin-bottom:14px;">${escapeHtml(label)}</div>`;
}

export function buttonHtml(href: string, label: string) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px auto;">
    <tr><td style="border-radius:8px;background:linear-gradient(135deg,#0EA5E9,#0369a1);">
      <a href="${href}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a>
    </td></tr>
  </table>`;
}
