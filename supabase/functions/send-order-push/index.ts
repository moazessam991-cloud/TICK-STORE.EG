import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.109.0";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SECRET_PATTERN = /^[0-9a-f]{64}$/i;
const MAX_BODY_BYTES = 1024;
const MAX_PUSH_DEVICES = 100;

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

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlJson(value: JsonRecord): string {
  return base64UrlBytes(
    new TextEncoder().encode(JSON.stringify(value)),
  );
}

function privateKeyBytes(value: string): ArrayBuffer {
  const pem = value
    .replaceAll("\\n", "\n")
    .trim();

  const encoded = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");

  if (!encoded) {
    throw new Error("invalid_private_key");
  }

  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

async function createFirebaseAccessToken(
  clientEmail: string,
  privateKey: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const header = base64UrlJson({
    alg: "RS256",
    typ: "JWT",
  });

  const payload = base64UrlJson({
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  });

  const unsignedJwt = `${header}.${payload}`;

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyBytes(privateKey),
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsignedJwt),
  );

  const assertion =
    `${unsignedJwt}.${base64UrlBytes(new Uint8Array(signature))}`;

  const tokenResponse = await fetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type:
          "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    },
  );

  const text = await tokenResponse.text();

  let body: JsonRecord = {};

  try {
    const parsed = JSON.parse(text);
    if (isRecord(parsed)) body = parsed;
  } catch {
    // Never expose provider output.
  }

  if (
    !tokenResponse.ok ||
    typeof body.access_token !== "string" ||
    !body.access_token
  ) {
    throw new Error(
      `firebase_oauth_http_${tokenResponse.status}`,
    );
  }

  return body.access_token;
}

function firebaseErrorCode(body: JsonRecord): string {
  const error = isRecord(body.error)
    ? body.error
    : {};

  if (Array.isArray(error.details)) {
    for (const detail of error.details) {
      if (
        isRecord(detail) &&
        typeof detail.errorCode === "string"
      ) {
        return detail.errorCode.slice(0, 80);
      }
    }
  }

  if (typeof error.status === "string") {
    return error.status.slice(0, 80);
  }

  return "unknown";
}

function isUnregisteredToken(body: JsonRecord): boolean {
  const error = isRecord(body.error)
    ? body.error
    : {};

  if (!Array.isArray(error.details)) {
    return false;
  }

  return error.details.some(
    (detail) =>
      isRecord(detail) &&
      detail.errorCode === "UNREGISTERED",
  );
}

function formatMoney(value: unknown): string {
  const amount = Number(value);

  return Number.isFinite(amount)
    ? amount.toFixed(2)
    : "0.00";
}

function getAdminUrl(): string | null {
  const configured =
    Deno.env.get("TICK_STOREFRONT_ORIGINS") || "";

  for (const rawOrigin of configured.split(",")) {
    const candidate = rawOrigin.trim();

    try {
      const url = new URL(candidate);

      if (url.protocol === "https:") {
        return `${url.origin}/admin`;
      }
    } catch {
      // Ignore malformed configured origins.
    }
  }

  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return jsonResponse(405, {
      ok: false,
      error: "method_not_allowed",
    });
  }

  const expectedSecret =
    Deno.env.get("TICK_PUSH_NOTIFICATION_SECRET") || "";

  const suppliedSecret =
    req.headers.get("x-tick-push-secret") || "";

  if (!safeSecretEqual(suppliedSecret, expectedSecret)) {
    return jsonResponse(401, {
      ok: false,
      error: "unauthorized",
    });
  }

  if (Deno.env.get("TICK_PUSH_ENABLED") !== "true") {
    return jsonResponse(503, {
      ok: false,
      error: "push_notifications_disabled",
    });
  }

  const contentLength =
    Number(req.headers.get("content-length") || "0");

  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_BODY_BYTES
  ) {
    return jsonResponse(413, {
      ok: false,
      error: "request_body_too_large",
    });
  }

  let rawBody = "";

  try {
    rawBody = await req.text();
  } catch {
    return jsonResponse(400, {
      ok: false,
      error: "invalid_request_body",
    });
  }

  if (
    new TextEncoder().encode(rawBody).byteLength >
    MAX_BODY_BYTES
  ) {
    return jsonResponse(413, {
      ok: false,
      error: "request_body_too_large",
    });
  }

  let body: unknown;

  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonResponse(400, {
      ok: false,
      error: "invalid_json",
    });
  }

  if (
    !isRecord(body) ||
    Object.keys(body).length !== 1 ||
    typeof body.order_id !== "string" ||
    !UUID_PATTERN.test(body.order_id)
  ) {
    return jsonResponse(400, {
      ok: false,
      error: "invalid_request_body",
    });
  }

  const orderId = body.order_id.toLowerCase();

  const supabaseUrl =
    (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");

  const serviceRoleKey =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

  const firebaseProjectId =
    (Deno.env.get("FIREBASE_PROJECT_ID") || "").trim();

  const firebaseClientEmail =
    (Deno.env.get("FIREBASE_CLIENT_EMAIL") || "").trim();

  const firebasePrivateKey =
    Deno.env.get("FIREBASE_PRIVATE_KEY") || "";

  if (
    !supabaseUrl ||
    !serviceRoleKey ||
    !firebaseProjectId ||
    !firebaseClientEmail ||
    !firebasePrivateKey
  ) {
    console.error(JSON.stringify({
      level: "error",
      event: "order_push_misconfigured",
    }));

    return jsonResponse(503, {
      ok: false,
      error: "push_service_unavailable",
    });
  }

  const supabase = createClient(
    supabaseUrl,
    serviceRoleKey,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );

  const { data: order, error: orderError } =
    await supabase
      .from("orders")
      .select(
        "id,total_amount,status,payment_method,payment_status,created_at",
      )
      .eq("id", orderId)
      .maybeSingle();

  if (orderError) {
    console.error(JSON.stringify({
      level: "error",
      event: "order_push_order_read_failed",
      order_id: orderId,
    }));

    return jsonResponse(500, {
      ok: false,
      error: "push_failed",
    });
  }

  if (!order) {
    return jsonResponse(404, {
      ok: false,
      error: "order_not_found",
    });
  }

  const { data: tokens, error: tokenError } =
    await supabase
      .from("push_tokens")
      .select("id,token")
      .order("last_seen", { ascending: false })
      .limit(MAX_PUSH_DEVICES);

  if (tokenError) {
    console.error(JSON.stringify({
      level: "error",
      event: "order_push_tokens_read_failed",
      order_id: orderId,
    }));

    return jsonResponse(500, {
      ok: false,
      error: "push_failed",
    });
  }

  if (!tokens?.length) {
    return jsonResponse(200, {
      ok: true,
      sent: 0,
      duplicate: 0,
      failed: 0,
      removed_invalid_tokens: 0,
      no_devices: true,
    });
  }

  let accessToken = "";

  try {
    accessToken = await createFirebaseAccessToken(
      firebaseClientEmail,
      firebasePrivateKey,
    );
  } catch {
    console.error(JSON.stringify({
      level: "error",
      event: "order_push_oauth_failed",
      order_id: orderId,
    }));

    return jsonResponse(502, {
      ok: false,
      error: "push_provider_failed",
    });
  }

  const adminUrl = getAdminUrl();

  let sent = 0;
  let duplicate = 0;
  let failed = 0;
  let removedInvalidTokens = 0;

  for (const device of tokens) {
    if (
      !device ||
      typeof device.id !== "string" ||
      !UUID_PATTERN.test(device.id) ||
      typeof device.token !== "string" ||
      device.token.length < 50 ||
      device.token.length > 4096
    ) {
      failed++;
      continue;
    }

    const { data: claim, error: claimError } =
      await supabase.rpc(
        "claim_order_push_delivery",
        {
          p_order_id: orderId,
          p_push_token_id: device.id,
        },
      );

    if (claimError) {
      console.error(JSON.stringify({
        level: "error",
        event: "order_push_claim_failed",
        order_id: orderId,
      }));

      failed++;
      continue;
    }

    if (!claim?.claimed) {
      duplicate++;
      continue;
    }

    const attemptCount =
      Number(claim.attempt_count);

    if (
      !Number.isInteger(attemptCount) ||
      attemptCount < 1
    ) {
      failed++;
      continue;
    }

    const notificationBody =
      `New order received • ${formatMoney(order.total_amount)} EGP`;

    const message: JsonRecord = {
      token: device.token,

      notification: {
        title: "🛒 New TICK Order",
        body: notificationBody,
      },

      data: {
        title: "🛒 New TICK Order",
        body: notificationBody,
        orderId,
        url: adminUrl || "/admin",
      },

      webpush: {
        headers: {
          Urgency: "high",
        },

        notification: {
          icon: "/icons/icon-192.png",
          badge: "/icons/icon-192.png",
          tag: `tick-order-${orderId}`,
          renotify: true,
          requireInteraction: true,
        },

        ...(adminUrl
          ? {
              fcm_options: {
                link: adminUrl,
              },
            }
          : {}),
      },
    };

    let fcmResponse: Response;

    try {
      fcmResponse = await fetch(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(firebaseProjectId)}/messages:send`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message,
          }),
        },
      );
    } catch {
      await supabase.rpc(
        "finish_order_push_delivery",
        {
          p_order_id: orderId,
          p_push_token_id: device.id,
          p_attempt_count: attemptCount,
          p_success: false,
          p_provider_message_id: null,
          p_error: "fcm_network_error",
        },
      );

      failed++;
      continue;
    }

    const fcmText =
      await fcmResponse.text();

    let fcmBody: JsonRecord = {};

    try {
      const parsed = JSON.parse(fcmText);

      if (isRecord(parsed)) {
        fcmBody = parsed;
      }
    } catch {
      // Never return provider content.
    }

    if (!fcmResponse.ok) {
      const errorCode =
        firebaseErrorCode(fcmBody);

      await supabase.rpc(
        "finish_order_push_delivery",
        {
          p_order_id: orderId,
          p_push_token_id: device.id,
          p_attempt_count: attemptCount,
          p_success: false,
          p_provider_message_id: null,
          p_error:
            `fcm_http_${fcmResponse.status}_${errorCode}`,
        },
      );

      if (isUnregisteredToken(fcmBody)) {
        const { error: deleteError } =
          await supabase
            .from("push_tokens")
            .delete()
            .eq("id", device.id);

        if (!deleteError) {
          removedInvalidTokens++;
        }
      }

      console.error(JSON.stringify({
        level: "error",
        event: "order_push_provider_failed",
        order_id: orderId,
        status: fcmResponse.status,
        code: errorCode,
      }));

      failed++;
      continue;
    }

    const providerMessageId =
      typeof fcmBody.name === "string"
        ? fcmBody.name.slice(0, 500)
        : null;

    const { data: finished, error: finishError } =
      await supabase.rpc(
        "finish_order_push_delivery",
        {
          p_order_id: orderId,
          p_push_token_id: device.id,
          p_attempt_count: attemptCount,
          p_success: true,
          p_provider_message_id: providerMessageId,
          p_error: null,
        },
      );

    if (finishError || finished !== true) {
      console.error(JSON.stringify({
        level: "error",
        event: "order_push_finish_failed",
        order_id: orderId,
      }));

      failed++;
      continue;
    }

    sent++;
  }

  return jsonResponse(200, {
    ok: true,
    sent,
    duplicate,
    failed,
    removed_invalid_tokens: removedInvalidTokens,
  });
});
