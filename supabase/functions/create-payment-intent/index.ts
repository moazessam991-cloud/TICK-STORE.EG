import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const PAYMOB_API_KEY = Deno.env.get('PAYMOB_API_KEY')
const PAYMOB_IFRAME_ID = Deno.env.get('PAYMOB_IFRAME_ID')
const PAYMOB_INTEGRATION_ID = Deno.env.get('PAYMOB_INTEGRATION_ID')

serve(async (req) => {
  const { orderId, amount, customer } = await req.json()

  // 1. Authenticate with Paymob
  const authRes = await fetch('https://egypt.paymob.com/api/auth/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: PAYMOB_API_KEY })
  })
  const { token: authToken } = await authRes.json()

  // 2. Register Order
  const orderRes = await fetch('https://egypt.paymob.com/api/ecommerce/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_token: authToken,
      delivery_needed: "false",
      amount_cents: amount * 100,
      currency: "EGP",
      merchant_order_id: orderId,
      items: []
    })
  })
  const { id: paymobOrderId } = await orderRes.json()

  // 3. Get Payment Key
  const payKeyRes = await fetch('https://egypt.paymob.com/api/acceptance/payment_keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_token: authToken,
      amount_cents: amount * 100,
      expiration: 3600,
      order_id: paymobOrderId,
      billing_data: {
        apartment: "NA",
        email: customer.email || "cl@tick.eg",
        floor: "NA",
        first_name: customer.fn,
        street: customer.addr || "NA",
        building: "NA",
        phone_number: customer.ph,
        shipping_method: "PKG",
        postal_code: "NA",
        city: customer.area,
        country: "EG",
        last_name: customer.ln,
        state: "NA"
      },
      currency: "EGP",
      integration_id: PAYMOB_INTEGRATION_ID
    })
  })
  const { token: paymentKey } = await payKeyRes.json()

  return new Response(
    JSON.stringify({ iframeUrl: `https://egypt.paymob.com/api/acceptance/iframes/${PAYMOB_IFRAME_ID}?payment_token=${paymentKey}` }),
    { headers: { "Content-Type": "application/json" } },
  )
})
