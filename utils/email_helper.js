// emailTemplate.js
// Renders either the magic-link or OTP password reset email template.
// Drop both HTML files alongside this file; require it from your Express routes.

const fs = require("fs");
const path = require("path");

const TEMPLATES = {
  link: path.join(__dirname, "password-reset-link.html"),
  otp: path.join(__dirname, "password-reset-otp.html"),
};

// ---------------------------------------------------------------------------
// Internal helper — replaces every {{KEY}} in a string
// ---------------------------------------------------------------------------
function applyReplacements(html, data) {
  return Object.entries(data).reduce((out, [key, value]) => {
    return out.replaceAll(`{{${key}}}`, value);
  }, html);
}

// ---------------------------------------------------------------------------
// Build the six individual digit boxes from a code string, e.g. "482916"
// ---------------------------------------------------------------------------
function buildOtpDigits(code) {
  return String(code)
    .split("")
    .map((d) => `<div class="otp-digit">${d}</div>`)
    .join("\n            ");
}

// ---------------------------------------------------------------------------
// renderLinkEmail(data) — magic-link variant
//
// Required:
//   data.SYSTEM_NAME    {string}  e.g. "NavyNet"
//   data.ORGANISATION   {string}  e.g. "Naval HQ"
//   data.RESET_URL      {string}  full one-time URL with token + expiry
//
// Optional:
//   data.EXPIRY_MINUTES {number}  default 30
//
// Returns: {string} rendered HTML
// ---------------------------------------------------------------------------
function renderLinkEmail(data) {
  const { SYSTEM_NAME, ORGANISATION, RESET_URL, EXPIRY_MINUTES = 30 } = data;

  if (!SYSTEM_NAME || !ORGANISATION || !RESET_URL) {
    throw new Error(
      "renderLinkEmail: SYSTEM_NAME, ORGANISATION and RESET_URL are required.",
    );
  }

  const html = fs.readFileSync(TEMPLATES.link, "utf-8");

  return applyReplacements(html, {
    SYSTEM_NAME,
    ORGANISATION,
    RESET_URL,
    EXPIRY_MINUTES: String(EXPIRY_MINUTES),
  });
}

module.exports = { renderLinkEmail, applyReplacements };
