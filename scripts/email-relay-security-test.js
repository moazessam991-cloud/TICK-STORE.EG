#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const config = read('supabase/config.toml');
const relay = read('supabase/functions/send-order-notification/index.ts');
const order = read('supabase/functions/create-order/index.ts');

assert(!/\[functions\.send-order-notification\]/.test(config), 'standalone relay remains deployable in config');
assert(relay.includes('notification_function_disabled'), 'relay does not fail closed');
assert(relay.includes('status: 410'), 'relay must return 410');
assert(!relay.includes('RESEND_API_KEY'), 'disabled relay still reads the email secret');
assert(!relay.includes('fetch('), 'disabled relay can still make an external request');
assert(!order.includes('RESEND_API_KEY'), 'public order function still sends email');
assert(!order.includes('firebase.googleapis.com'), 'public order function still sends push');
assert(!order.includes('TWILIO'), 'public order function still sends WhatsApp');

console.log('email-relay-security-test: anonymous relay and automatic checkout notifications are disabled');
