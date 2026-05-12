'use strict';

const twilio = require('twilio');

/**
 * @returns {{ client: import('twilio').Twilio; from: string } | null}
 */
function getClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!sid || !token || !from) return null;
  return { client: twilio(sid, token), from: from.startsWith('whatsapp:') ? from : `whatsapp:${from}` };
}

function isConfigured() {
  return Boolean(getClient());
}

/**
 * Accepts Egyptian-style 01xxxxxxxxx, +20..., whatsapp:+20...
 * Returns Twilio "whatsapp:+E164" or null.
 */
function toWhatsAppAddress(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  if (s.toLowerCase().startsWith('whatsapp:')) {
    const rest = s.slice('whatsapp:'.length).replace(/\s/g, '');
    if (!rest.startsWith('+')) return null;
    return `whatsapp:${rest}`;
  }
  const digits = s.replace(/\D/g, '');
  if (!digits) return null;
  let e164;
  if (digits.startsWith('20') && digits.length >= 11) e164 = `+${digits}`;
  else if (digits.startsWith('0') && digits.length >= 10) e164 = `+20${digits.slice(1)}`;
  else if (digits.length === 10 && digits.startsWith('1')) e164 = `+20${digits}`;
  else if (s.startsWith('+')) e164 = `+${digits}`;
  else e164 = `+${digits}`;
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) return null;
  return `whatsapp:${e164}`;
}

/**
 * @param {{ to: string; body: string }} opts
 */
async function sendWhatsApp(opts) {
  const cfg = getClient();
  if (!cfg) {
    const err = new Error('twilio_not_configured');
    err.code = 'TWILIO_NOT_CONFIGURED';
    throw err;
  }
  const to = toWhatsAppAddress(opts.to);
  if (!to) {
    const err = new Error('invalid_to');
    err.code = 'INVALID_TO';
    throw err;
  }
  const body = String(opts.body == null ? '' : opts.body).trim();
  if (!body) {
    const err = new Error('empty_body');
    err.code = 'EMPTY_BODY';
    throw err;
  }
  if (body.length > 1600) {
    const err = new Error('body_too_long');
    err.code = 'BODY_TOO_LONG';
    throw err;
  }
  const msg = await cfg.client.messages.create({
    from: cfg.from,
    to,
    body,
  });
  return { sid: msg.sid, status: msg.status };
}

/**
 * Validate Twilio webhook signature (x-www-form-urlencoded body).
 * @param {string} fullUrl - Exact public URL Twilio posted to (no trailing slash mismatch)
 * @param {Record<string, string>} params - req.body as plain object
 * @param {string|undefined} signature - req.get('X-Twilio-Signature')
 */
function validateWebhook(fullUrl, params, signature) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return false;
  if (!signature || !fullUrl) return false;
  return twilio.validateRequest(token, signature, fullUrl, params);
}

module.exports = {
  isConfigured,
  getClient,
  toWhatsAppAddress,
  sendWhatsApp,
  validateWebhook,
};
