import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts"

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const PAYMOB_HMAC_SECRET = Deno.env.get('PAYMOB_HMAC_SECRET')

const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!)

serve(async (req) => {
  const body = await req.json()
  const hmac = req.headers.get('hmac')

  // TODO: Verify HMAC signature from Paymob
  // Paymob sends a concatenated string of values to verify authenticity

  const { obj } = body
  const orderId = obj.order.merchant_order_id
  const success = obj.success
  const transactionId = obj.id

  if (success) {
    await supabase
      .from('orders')
      .update({
        status: 'confirmed',
        payment_status: 'paid',
        payment_id: String(transactionId)
      })
      .eq('id', orderId)
  } else {
    await supabase
      .from('orders')
      .update({ status: 'cancelled', payment_status: 'failed' })
      .eq('id', orderId)
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } })
})
