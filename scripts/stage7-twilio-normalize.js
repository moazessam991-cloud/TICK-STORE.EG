'use strict';

const assert = require('assert');
const { toWhatsAppAddress } = require('../server/twilioWhatsApp');

assert.strictEqual(toWhatsAppAddress('01001234567'), 'whatsapp:+201001234567');
assert.strictEqual(toWhatsAppAddress('+20 100 123 4567'), 'whatsapp:+201001234567');
assert.strictEqual(toWhatsAppAddress('whatsapp:+201001234567'), 'whatsapp:+201001234567');
assert.strictEqual(toWhatsAppAddress(''), null);
assert.strictEqual(toWhatsAppAddress('invalid'), null);

console.log('Stage 7 OK: Twilio WhatsApp number normalization');
