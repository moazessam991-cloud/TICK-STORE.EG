import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.109.0";

const MAX_BODY_BYTES = 32 * 1024;
const MAX_LINE_ITEMS = 20;
const MAX_ITEM_QUANTITY = 10;
const MAX_TOTAL_QUANTITY = 30;
const MAX_ORDER_TOTAL = 1_000_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHECKOUT_TOKEN_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64})$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const PUBLIC_ORDER_RESPONSE_FIELDS = [
  "id",
  "total_amount",
  "payment_method",
  "payment_status",
  "payment_expires_at",
  "status",
  "created_at",
  "idempotent_replay",
] as const;
const allowedOrigins = new Set(
  String(Deno.env.get("TICK_STOREFRONT_ORIGINS") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => new URL(value).origin),
);
const allowLocalhost = Deno.env.get("TICK_ALLOW_LOCALHOST_ORIGINS") === "true";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: JsonRecord, keys: Set<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function publicOrderResponse(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : "";
  const totalAmount = typeof value.total_amount === "number"
    ? value.total_amount
    : Number(value.total_amount);
  if (!UUID_PATTERN.test(id) || !Number.isFinite(totalAmount) || totalAmount < 0) return null;

  const projected: JsonRecord = {};
  for (const field of PUBLIC_ORDER_RESPONSE_FIELDS) {
    if (field === "total_amount") projected[field] = totalAmount;
    else if (field === "idempotent_replay") projected[field] = value[field] === true;
    else if (field === "payment_expires_at") {
      projected[field] = typeof value[field] === "string" ? value[field] : null;
    } else {
      projected[field] = typeof value[field] === "string" ? value[field] : null;
    }
  }
  return projected;
}

function normalizedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

function normalizedPhone(value: unknown): { display: string; digits: string } | null {
  const display = normalizedText(value, 24);
  if (!display || !/^\+?[0-9 ()-]+$/.test(display)) return null;
  const digits = display.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  return { display, digits };
}

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (allowedOrigins.has(parsed.origin)) return true;
  return allowLocalhost && parsed.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
}

function responseHeaders(origin: string | null): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
  if (origin && isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Headers"] = "apikey, authorization, content-type, x-client-info";
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Max-Age"] = "600";
  }
  return headers;
}

function jsonResponse(origin: string | null, status: number, body: JsonRecord, extraHeaders: HeadersInit = {}): Response {
  const headers = new Headers(responseHeaders(origin));
  new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  return new Response(JSON.stringify(body), { status, headers });
}

function sourceIp(req: Request): string {
  if (Deno.env.get("TICK_TRUST_EDGE_FORWARDED_IP") !== "true") return "unavailable";
  const candidate = req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    String(req.headers.get("x-forwarded-for") || "").split(",", 1)[0].trim();
  return candidate && /^[0-9a-f:.]{3,64}$/i.test(candidate) ? candidate.toLowerCase() : "unavailable";
}

async function fingerprint(secret: string, scope: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${scope}:${value}`),
  ));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateRequestBody(body: unknown):
  | { error: string }
  | { orderData: JsonRecord; items: JsonRecord[]; phoneDigits: string; checkoutToken: string; payment: "COD" | "InstaPay" } {
  if (!isRecord(body) || !hasOnlyKeys(body, new Set(["orderData", "items"]))) return { error: "invalid_request_body" };
  if (!isRecord(body.orderData) || !Array.isArray(body.items)) return { error: "invalid_request_body" };
  const order = body.orderData;
  if (!hasOnlyKeys(order, new Set(["total", "customer", "payment", "notes", "checkoutToken"]))) {
    return { error: "invalid_order_data" };
  }
  if (typeof order.total !== "number" || !Number.isFinite(order.total) || order.total < 0 || order.total > MAX_ORDER_TOTAL) {
    return { error: "invalid_order_total" };
  }
  const checkoutToken = normalizedText(order.checkoutToken, 128);
  if (!checkoutToken || !CHECKOUT_TOKEN_PATTERN.test(checkoutToken)) return { error: "invalid_checkout_token" };
  const paymentValue = normalizedText(order.payment, 20)?.toLowerCase();
  const payment = paymentValue === "cod" ? "COD" : paymentValue === "instapay" ? "InstaPay" : null;
  if (!payment) return { error: "invalid_payment_method" };
  if (!isRecord(order.customer) || !hasOnlyKeys(order.customer, new Set(["fn", "ln", "ph", "email", "area", "city", "addr", "notes"]))) {
    return { error: "invalid_customer_data" };
  }
  const customer = order.customer;
  const fn = normalizedText(customer.fn, 60);
  const ln = normalizedText(customer.ln ?? "", 60);
  const phone = normalizedPhone(customer.ph);
  const email = normalizedText(customer.email ?? "", 254);
  const area = normalizedText(customer.area, 80);
  const city = normalizedText(customer.city ?? "", 80);
  const addr = normalizedText(customer.addr, 300);
  const customerNotes = normalizedText(customer.notes ?? "", 500);
  const notes = normalizedText(order.notes ?? "", 500);
  if (!fn || !phone || !area || !addr || ln === null || city === null || customerNotes === null || notes === null || email === null) {
    return { error: "invalid_customer_data" };
  }
  if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return { error: "invalid_customer_email" };
  if (body.items.length < 1) return { error: "empty_order_items" };
  if (body.items.length > MAX_LINE_ITEMS) return { error: "too_many_order_items" };
  let totalQuantity = 0;
  const items: JsonRecord[] = [];
  for (const item of body.items) {
    if (!isRecord(item) || !hasOnlyKeys(item, new Set(["pid", "qty", "isSt", "strapConfig"]))) {
      return { error: "invalid_order_item" };
    }
    if (typeof item.pid !== "string" || !UUID_PATTERN.test(item.pid)) return { error: "invalid_order_item" };
    const quantity = item.qty;
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_ITEM_QUANTITY) {
      return { error: "invalid_item_quantity" };
    }
    if (item.isSt !== undefined && typeof item.isSt !== "boolean") return { error: "invalid_order_item" };
    let strapConfig: JsonRecord | null = null;
    if (item.strapConfig !== undefined && item.strapConfig !== null) {
      if (!isRecord(item.strapConfig) || !hasOnlyKeys(item.strapConfig, new Set(["color", "colorHex", "width"]))) {
        return { error: "invalid_strap_configuration" };
      }
      const color = normalizedText(item.strapConfig.color ?? "", 80);
      const colorHex = normalizedText(item.strapConfig.colorHex ?? "", 20);
      const width = normalizedText(item.strapConfig.width ?? "", 30);
      if (color === null || colorHex === null || width === null) return { error: "invalid_strap_configuration" };
      strapConfig = { color, colorHex, width };
    }
    totalQuantity += quantity;
    if (totalQuantity > MAX_TOTAL_QUANTITY) return { error: "order_quantity_limit" };
    items.push({ pid: item.pid.toLowerCase(), qty: quantity, isSt: item.isSt === true, strapConfig });
  }
  return {
    orderData: {
      total: order.total,
      payment,
      notes,
      checkoutToken,
      customer: { fn, ln, ph: phone.display, email, area, city, addr, notes: customerNotes },
    },
    items,
    phoneDigits: phone.digits,
    checkoutToken,
    payment,
  };
}

function safeRpcError(error: { message?: string } | null): { status: number; code: string } {
  const message = String(error?.message || "");
  const clientErrors = new Set([
    "empty_order_items", "invalid_order_item", "invalid_item_quantity", "invalid_order_total",
    "invalid_payment_method", "invalid_order_data", "invalid_customer_data", "product_not_found",
    "insufficient_stock", "order_total_changed", "payment_method_disabled", "cod_active_order_limit",
  ]);
  const code = clientErrors.has(message) ? message : "order_creation_failed";
  if (code === "insufficient_stock" || code === "order_total_changed" || code === "payment_method_disabled") return { status: 409, code };
  if (code === "product_not_found") return { status: 404, code };
  if (code === "cod_active_order_limit") return { status: 429, code };
  if (code === "order_creation_failed") return { status: 500, code };
  return { status: 400, code };
}

function queueOrderEmailNotification(orderId: string): void {
  const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
  const notificationSecret = Deno.env.get("TICK_NOTIFICATION_SECRET") || "";

  if (
    !supabaseUrl ||
    !UUID_PATTERN.test(orderId) ||
    !HASH_PATTERN.test(notificationSecret)
  ) {
    console.error(JSON.stringify({
      level: "error",
      event: "order_notification_not_queued",
      code: "ORDER_NOTIFY_CFG_001",
      order_id: orderId,
    }));
    return;
  }

  const runtime = (
    globalThis as typeof globalThis & {
      EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void };
    }
  ).EdgeRuntime;

  if (!runtime?.waitUntil) {
    console.error(JSON.stringify({
      level: "error",
      event: "order_notification_runtime_unavailable",
      code: "ORDER_NOTIFY_RUNTIME_001",
      order_id: orderId,
    }));
    return;
  }

  const task = (async () => {
    try {
      const response = await fetch(
        `${supabaseUrl}/functions/v1/send-order-notification`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-tick-notification-secret": notificationSecret,
          },
          body: JSON.stringify({ order_id: orderId }),
        },
      );

      if (!response.ok) {
        console.error(JSON.stringify({
          level: "error",
          event: "order_notification_failed",
          code: "ORDER_NOTIFY_HTTP_001",
          order_id: orderId,
          status: response.status,
        }));
      }
    } catch {
      console.error(JSON.stringify({
        level: "error",
        event: "order_notification_failed",
        code: "ORDER_NOTIFY_NETWORK_001",
        order_id: orderId,
      }));
    }
  })();

  runtime.waitUntil(task);
}


function queueOrderPushNotification(orderId: string): void {
  if (Deno.env.get("TICK_PUSH_ENABLED") !== "true") {
    return;
  }

  const supabaseUrl =
    (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");

  const pushSecret =
    Deno.env.get("TICK_PUSH_NOTIFICATION_SECRET") || "";

  if (
    !supabaseUrl ||
    !UUID_PATTERN.test(orderId) ||
    !HASH_PATTERN.test(pushSecret)
  ) {
    console.error(JSON.stringify({
      level: "error",
      event: "order_push_not_queued",
      code: "ORDER_PUSH_CFG_001",
      order_id: orderId,
    }));
    return;
  }

  const runtime = (
    globalThis as typeof globalThis & {
      EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void };
    }
  ).EdgeRuntime;

  if (!runtime?.waitUntil) {
    console.error(JSON.stringify({
      level: "error",
      event: "order_push_runtime_unavailable",
      code: "ORDER_PUSH_RUNTIME_001",
      order_id: orderId,
    }));
    return;
  }

  const task = (async () => {
    try {
      const response = await fetch(
        `${supabaseUrl}/functions/v1/send-order-push`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-tick-push-secret": pushSecret,
          },
          body: JSON.stringify({ order_id: orderId }),
        },
      );

      if (!response.ok) {
        console.error(JSON.stringify({
          level: "error",
          event: "order_push_failed",
          code: "ORDER_PUSH_HTTP_001",
          order_id: orderId,
          status: response.status,
        }));
      }
    } catch {
      console.error(JSON.stringify({
        level: "error",
        event: "order_push_failed",
        code: "ORDER_PUSH_NETWORK_001",
        order_id: orderId,
      }));
    }
  })();

  runtime.waitUntil(task);
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  if (!isAllowedOrigin(origin)) return jsonResponse(origin, 403, { ok: false, error: "origin_not_allowed" });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders(origin) });
  if (req.method !== "POST") return jsonResponse(origin, 405, { ok: false, error: "method_not_allowed" }, { Allow: "POST, OPTIONS" });
  const contentLength = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return jsonResponse(origin, 413, { ok: false, error: "request_body_too_large" });
  }
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return jsonResponse(origin, 400, { ok: false, error: "invalid_request_body" });
  }
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return jsonResponse(origin, 413, { ok: false, error: "request_body_too_large" });
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonResponse(origin, 400, { ok: false, error: "invalid_json" });
  }
  const validated = validateRequestBody(body);
  if ("error" in validated) return jsonResponse(origin, 400, { ok: false, error: validated.error });
  if (validated.payment === "InstaPay" && Deno.env.get("TICK_INSTAPAY_ENABLED") !== "true") {
    return jsonResponse(origin, 409, { ok: false, error: "payment_method_disabled" });
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const abuseSecret = Deno.env.get("TICK_ORDER_ABUSE_SECRET") || "";
  if (!supabaseUrl || !serviceRoleKey || abuseSecret.length < 32) {
    console.error(JSON.stringify({ level: "error", event: "order_service_misconfigured", code: "ORDER_CFG_001" }));
    return jsonResponse(origin, 503, { ok: false, error: "order_service_unavailable" });
  }
  try {
    const [ipHash, phoneHash, checkoutHash] = await Promise.all([
      fingerprint(abuseSecret, "ip", sourceIp(req)),
      fingerprint(abuseSecret, "phone", validated.phoneDigits),
      fingerprint(abuseSecret, "checkout", validated.checkoutToken),
    ]);
    if (![ipHash, phoneHash, checkoutHash].every((value) => HASH_PATTERN.test(value))) {
      throw new Error("fingerprint_failed");
    }
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: abuse, error: abuseError } = await supabase.rpc("consume_order_abuse_limits", {
      p_ip_hash: ipHash,
      p_phone_hash: phoneHash,
      p_checkout_hash: checkoutHash,
    });
    if (abuseError) {
      console.error(JSON.stringify({ level: "error", event: "order_abuse_gate_failed", code: "ORDER_ABUSE_002" }));
      return jsonResponse(origin, 503, { ok: false, error: "order_service_unavailable" });
    }
    if (!abuse?.allowed) {
      const retryAfter = Math.max(1, Math.min(1800, Number(abuse?.retry_after_seconds) || 60));
      console.warn(JSON.stringify({
        level: "warning",
        event: "order_abuse_denied",
        code: "ORDER_ABUSE_429",
        scope: String(abuse?.scope || "combined"),
        fingerprint_prefix: ipHash.slice(0, 12),
      }));
      return jsonResponse(
        origin,
        429,
        { ok: false, error: "order_rate_limited", retry_after_seconds: retryAfter },
        { "Retry-After": String(retryAfter) },
      );
    }
    const { data: order, error: orderError } = await supabase.rpc("create_preview_order_with_stock", {
      p_order: validated.orderData,
      p_items: validated.items,
      p_phone_hash: phoneHash,
    });
    if (orderError) {
      const mapped = safeRpcError(orderError);
      if (mapped.status >= 500) {
        console.error(JSON.stringify({ level: "error", event: "order_creation_failed", code: "ORDER_CREATE_500" }));
      }
      const headers = mapped.status === 429 ? { "Retry-After": "1800" } : {};
      return jsonResponse(origin, mapped.status, { ok: false, error: mapped.code }, headers);
    }
    const publicOrder = publicOrderResponse(order);
    if (!publicOrder) {
      console.error(JSON.stringify({ level: "error", event: "order_creation_missing_result", code: "ORDER_CREATE_501" }));
      return jsonResponse(origin, 500, { ok: false, error: "order_creation_failed" });
    }
    // Order creation is already committed at this point. Notification runs
    // independently and must never change the successful checkout response.
    try {
      queueOrderEmailNotification(String(publicOrder.id));
    } catch {
      console.error(JSON.stringify({
        level: "error",
        event: "order_notification_queue_failed",
        code: "ORDER_NOTIFY_QUEUE_001",
        order_id: String(publicOrder.id),
      }));
    }

    try {
      queueOrderPushNotification(String(publicOrder.id));
    } catch {
      console.error(JSON.stringify({
        level: "error",
        event: "order_push_queue_failed",
        code: "ORDER_PUSH_QUEUE_001",
        order_id: String(publicOrder.id),
      }));
    }

    return jsonResponse(origin, 200, { ok: true, order: publicOrder });
  } catch {
    console.error(JSON.stringify({ level: "error", event: "order_request_failed", code: "ORDER_CREATE_502" }));
    return jsonResponse(origin, 500, { ok: false, error: "order_creation_failed" });
  }
});
