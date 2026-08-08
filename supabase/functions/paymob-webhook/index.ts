import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts"

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const PAYMOB_HMAC_SECRET = Deno.env.get('PAYMOB_HMAC_SECRET')

const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!)
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function transactionHmacPayload(obj: any) {
  const order = obj?.order || {}
  const source = obj?.source_data || {}
  return [
    obj?.amount_cents,
    obj?.created_at,
    obj?.currency,
    obj?.error_occured,
    obj?.has_parent_transaction,
    obj?.id,
    obj?.integration_id,
    obj?.is_3d_secure,
    obj?.is_auth,
    obj?.is_capture,
    obj?.is_refunded,
    obj?.is_standalone_payment,
    obj?.is_voided,
    order.id,
    obj?.owner,
    obj?.pending,
    source.pan,
    source.sub_type,
    source.type,
    obj?.success,
  ].map((value) => String(value ?? '')).join('')
}

async function calculateHmac(payload: string, secret: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign']
  )
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  )
  return Array.from(signature).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function safeEqualHex(left: string, right: string) {
  if (!/^[0-9a-f]{128}$/i.test(left) || !/^[0-9a-f]{128}$/i.test(right)) return false
  let mismatch = 0
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return mismatch === 0
}

serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' })
  if (!PAYMOB_HMAC_SECRET) return jsonResponse(503, { error: 'paymob_hmac_not_configured' })

  let body: any
  try {
    body = await req.json()
  } catch {
    return jsonResponse(400, { error: 'invalid_json' })
  }

  const obj = body?.obj
  if (!obj || typeof obj !== 'object') return jsonResponse(400, { error: 'invalid_callback' })

  const suppliedHmac = (
    new URL(req.url).searchParams.get('hmac') || req.headers.get('hmac') || ''
  ).trim().toLowerCase()
  const expectedHmac = await calculateHmac(transactionHmacPayload(obj), PAYMOB_HMAC_SECRET)
  if (!safeEqualHex(suppliedHmac, expectedHmac)) {
    return jsonResponse(401, { error: 'invalid_hmac' })
  }

  const orderId = String(obj.order?.merchant_order_id || '')
  const transactionId = String(obj.id || '')
  const amountCents = Number(obj.amount_cents)
  if (!UUID_PATTERN.test(orderId) || !transactionId || !Number.isInteger(amountCents) || amountCents < 0) {
    return jsonResponse(400, { error: 'invalid_callback' })
  }

  if (obj.success === true) {
    const { data, error } = await supabase.rpc('confirm_card_payment', {
      p_order_id: orderId,
      p_transaction_id: transactionId,
      p_amount: amountCents / 100,
    })

    if (error) return jsonResponse(500, { error: 'payment_confirmation_failed' })
    if (!data) return jsonResponse(404, { error: 'order_not_found' })
    if (data.reason && data.reason !== 'already_paid') {
      return jsonResponse(409, { error: data.reason })
    }
  } else {
    const { data, error } = await supabase.rpc('cancel_order_with_stock', {
      p_order_id: orderId,
      p_expected_payment_method: 'Visa',
    })

    if (error) return jsonResponse(500, { error: 'payment_cancellation_failed' })
    if (!data) return jsonResponse(404, { error: 'order_not_found' })
    if (data.reason && !['already_cancelled', 'paid_order_cancellation_unsupported'].includes(data.reason)) {
      return jsonResponse(409, { error: data.reason })
    }
  }

  return jsonResponse(200, { ok: true })
})
