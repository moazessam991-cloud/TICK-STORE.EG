import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Disabled for limited preview. Order notifications must later be rebuilt as
// an authenticated, database-backed job; browser-supplied recipients or HTML
// are never accepted here.
Deno.serve(() => new Response(
  JSON.stringify({ ok: false, error: "notification_function_disabled" }),
  {
    status: 410,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  },
));
