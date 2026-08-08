import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Paymob/card checkout is deliberately unavailable during limited preview.
Deno.serve(() => new Response(
  JSON.stringify({ ok: false, error: "card_payments_disabled" }),
  {
    status: 410,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  },
));
