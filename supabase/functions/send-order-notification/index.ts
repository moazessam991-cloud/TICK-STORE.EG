import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.109.0";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SECRET_PATTERN = /^[0-9a-f]{64}$/i;
const MAX_BODY_BYTES = 1024;

type JsonRecord = Record<string, unknown>;

function jsonResponse(status: number, body: JsonRecord): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeSecretEqual(candidate: string, expected: string): boolean {
  if (!SECRET_PATTERN.test(candidate) || !SECRET_PATTERN.test(expected)) {
    return false;
  }

  let mismatch = 0;
  for (let i = 0; i < 64; i++) {
    mismatch |= candidate.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function money(value: unknown): string {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount.toFixed(2) : "0.00";
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  const expectedSecret = Deno.env.get("TICK_NOTIFICATION_SECRET") || "";
  const suppliedSecret = req.headers.get("x-tick-notification-secret") || "";

  if (!safeSecretEqual(suppliedSecret, expectedSecret)) {
    return jsonResponse(401, { ok: false, error: "unauthorized" });
  }

  const contentLength = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return jsonResponse(413, { ok: false, error: "request_body_too_large" });
  }

  let rawBody = "";
  try {
    rawBody = await req.text();
  } catch {
    return jsonResponse(400, { ok: false, error: "invalid_request_body" });
  }

  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return jsonResponse(413, { ok: false, error: "request_body_too_large" });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonResponse(400, { ok: false, error: "invalid_json" });
  }

  if (
    !isRecord(body) ||
    Object.keys(body).length !== 1 ||
    typeof body.order_id !== "string" ||
    !UUID_PATTERN.test(body.order_id)
  ) {
    return jsonResponse(400, { ok: false, error: "invalid_request_body" });
  }

  const orderId = body.order_id.toLowerCase();

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const resendApiKey = Deno.env.get("RESEND_API_KEY") || "";
  const adminEmail = (Deno.env.get("ADMIN_EMAIL") || "").trim();

  if (
    !supabaseUrl ||
    !serviceRoleKey ||
    !resendApiKey ||
    !adminEmail ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)
  ) {
    console.error(JSON.stringify({
      level: "error",
      event: "order_email_misconfigured",
    }));
    return jsonResponse(503, {
      ok: false,
      error: "notification_service_unavailable",
    });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { data: claim, error: claimError } = await supabase.rpc(
    "claim_order_email_notification",
    { p_order_id: orderId },
  );

  if (claimError) {
    console.error(JSON.stringify({
      level: "error",
      event: "order_email_claim_failed",
      order_id: orderId,
    }));
    return jsonResponse(500, {
      ok: false,
      error: "notification_failed",
    });
  }

  if (!claim?.claimed) {
    const claimState = String(claim?.state || "unknown");

    if (claimState === "missing") {
      return jsonResponse(404, {
        ok: false,
        error: "order_not_found",
      });
    }

    return jsonResponse(200, {
      ok: true,
      sent: claimState === "sent",
      duplicate: true,
      state: claimState,
    });
  }

  const attemptCount = Number(claim?.attempt_count);
  if (!Number.isInteger(attemptCount) || attemptCount < 1) {
    console.error(JSON.stringify({
      level: "error",
      event: "order_email_invalid_claim",
      order_id: orderId,
    }));

    return jsonResponse(500, {
      ok: false,
      error: "notification_failed",
    });
  }

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select(
      "id,status,total_amount,payment_method,payment_status,customer_name,customer_phone,customer_email,shipping_address,notes,created_at",
    )
    .eq("id", orderId)
    .maybeSingle();

  if (orderError || !order) {
    await supabase.rpc("finish_order_email_notification", {
      p_order_id: orderId,
      p_attempt_count: attemptCount,
      p_success: false,
      p_provider_message_id: null,
      p_error: "order_not_found",
    });

    return jsonResponse(404, {
      ok: false,
      error: "order_not_found",
    });
  }

  const { data: items, error: itemsError } = await supabase
    .from("order_items")
    .select("product_id,quantity,price_at_purchase,metadata,products(name)")
    .eq("order_id", orderId)
    .order("created_at", { ascending: true });

  if (itemsError) {
    await supabase.rpc("finish_order_email_notification", {
      p_order_id: orderId,
      p_attempt_count: attemptCount,
      p_success: false,
      p_provider_message_id: null,
      p_error: "order_items_read_failed",
    });

    return jsonResponse(500, {
      ok: false,
      error: "notification_failed",
    });
  }

  const itemRows = (items || []).map((item: any) => {
    const productName =
      item?.products && typeof item.products.name === "string"
        ? item.products.name
        : "Product";

    const quantity = Number(item?.quantity) || 0;
    const price = Number(item?.price_at_purchase) || 0;

    return `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(productName)}</td>
        <td style="padding:8px;border-bottom:1px solid #ddd;text-align:center">${quantity}</td>
        <td style="padding:8px;border-bottom:1px solid #ddd;text-align:right">${money(price)} EGP</td>
        <td style="padding:8px;border-bottom:1px solid #ddd;text-align:right">${money(price * quantity)} EGP</td>
      </tr>
    `;
  }).join("");

  const address =
    order.shipping_address && typeof order.shipping_address === "object"
      ? order.shipping_address as JsonRecord
      : {};

  const addressLines = [
    address.area,
    address.city,
    address.addr,
  ]
    .filter((value) => typeof value === "string" && value.trim())
    .map(escapeHtml)
    .join("<br>");

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:720px;margin:auto">
      <h2>🛒 New TICK Order</h2>

      <p><strong>Order ID:</strong> ${escapeHtml(order.id)}</p>
      <p><strong>Customer:</strong> ${escapeHtml(order.customer_name || "-")}</p>
      <p><strong>Phone:</strong> ${escapeHtml(order.customer_phone || "-")}</p>
      <p><strong>Email:</strong> ${escapeHtml(order.customer_email || "-")}</p>

      <p><strong>Payment:</strong> ${escapeHtml(order.payment_method || "-")}</p>
      <p><strong>Payment status:</strong> ${escapeHtml(order.payment_status || "-")}</p>
      <p><strong>Order status:</strong> ${escapeHtml(order.status || "-")}</p>
      <p><strong>Total:</strong> ${money(order.total_amount)} EGP</p>

      <hr>

      <h3>Items</h3>

      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr>
            <th style="padding:8px;text-align:left">Product</th>
            <th style="padding:8px;text-align:center">Qty</th>
            <th style="padding:8px;text-align:right">Price</th>
            <th style="padding:8px;text-align:right">Subtotal</th>
          </tr>
        </thead>
        <tbody>
          ${itemRows || '<tr><td colspan="4">No items</td></tr>'}
        </tbody>
      </table>

      <hr>

      <p><strong>Address</strong><br>${addressLines || "-"}</p>
      <p><strong>Notes:</strong> ${escapeHtml(order.notes || "-")}</p>
      <p><strong>Created:</strong> ${escapeHtml(order.created_at)}</p>
    </div>
  `;

  let resendResponse: Response;

  try {
    resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",

        // Stable key for the same order. This is an additional duplicate-send
        // safeguard on top of the database claim.
        "Idempotency-Key": `tick-new-order-${orderId}`,
      },
      body: JSON.stringify({
        from: "TICK <onboarding@resend.dev>",
        to: [adminEmail],
        subject: `🛒 New TICK Order - ${String(order.customer_name || "Customer").slice(0, 80)}`,
        html,
      }),
    });
  } catch {
    await supabase.rpc("finish_order_email_notification", {
      p_order_id: orderId,
      p_attempt_count: attemptCount,
      p_success: false,
      p_provider_message_id: null,
      p_error: "resend_network_error",
    });

    return jsonResponse(502, {
      ok: false,
      error: "notification_provider_failed",
    });
  }

  const resendText = await resendResponse.text();

  let resendBody: JsonRecord = {};
  try {
    const parsed = JSON.parse(resendText);
    if (isRecord(parsed)) resendBody = parsed;
  } catch {
    // Never return raw provider content.
  }

  if (!resendResponse.ok) {
    await supabase.rpc("finish_order_email_notification", {
      p_order_id: orderId,
      p_attempt_count: attemptCount,
      p_success: false,
      p_provider_message_id: null,
      p_error: `resend_http_${resendResponse.status}`,
    });

    console.error(JSON.stringify({
      level: "error",
      event: "order_email_provider_failed",
      order_id: orderId,
      status: resendResponse.status,
    }));

    return jsonResponse(502, {
      ok: false,
      error: "notification_provider_failed",
    });
  }

  const providerMessageId =
    typeof resendBody.id === "string"
      ? resendBody.id.slice(0, 255)
      : null;

  const { error: finishError } = await supabase.rpc(
    "finish_order_email_notification",
    {
      p_order_id: orderId,
      p_attempt_count: attemptCount,
      p_success: true,
      p_provider_message_id: providerMessageId,
      p_error: null,
    },
  );

  if (finishError) {
    console.error(JSON.stringify({
      level: "error",
      event: "order_email_finish_failed",
      order_id: orderId,
    }));

    return jsonResponse(500, {
      ok: false,
      error: "notification_state_failed",
    });
  }

  return jsonResponse(200, {
    ok: true,
    sent: true,
    duplicate: false,
  });
});
