import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(async (req) => {
  const order = await req.json();

  const items = (order.items || [])
    .map(
      (i: any) =>
        `• ${i.name} × ${i.qty} = ${Number(i.price) * Number(i.qty)} EGP`
    )
    .join("<br>");

  const html = `
    <h2>🛒 New TICK Order</h2>

    <p><strong>Customer:</strong> ${order.customer.fn} ${order.customer.ln}</p>
    <p><strong>Phone:</strong> ${order.customer.ph}</p>
    <p><strong>Email:</strong> ${order.customer.email || "-"}</p>

    <p><strong>Payment:</strong> ${order.payment}</p>
    <p><strong>Total:</strong> ${order.total} EGP</p>

    <hr>

    <h3>Items</h3>

    ${items}

    <hr>

    <p><strong>Address</strong></p>

    <p>
      ${order.customer.area}<br>
      ${order.customer.addr}
    </p>

    <p><strong>Notes:</strong> ${order.notes || "-"}</p>
  `;

  const resend = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "TICK <onboarding@resend.dev>",
      to: Deno.env.get("ADMIN_EMAIL"),
      subject: `🛒 New Order - ${order.customer.fn}`,
      html,
    }),
  });

  const body = await resend.text();

  return new Response(body, {
    status: resend.status,
    headers: {
      "Content-Type": "application/json",
    },
  });
});