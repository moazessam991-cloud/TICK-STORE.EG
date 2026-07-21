import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function escapeHtml(value: unknown): string {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };

  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) => entities[character]
  );
}

function base64UrlEncode(value: string | Uint8Array): string {
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : value;

  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function privateKeyToPkcs8(privateKey: string): ArrayBuffer {
  const normalizedKey = privateKey.replace(/\\n/g, "\n");

  const base64Key = normalizedKey
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");

  const binaryKey = atob(base64Key);
  const bytes = new Uint8Array(binaryKey.length);

  for (let i = 0; i < binaryKey.length; i += 1) {
    bytes[i] = binaryKey.charCodeAt(i);
  }

  return bytes.buffer;
}

async function getFirebaseAccessToken(): Promise<{
  accessToken: string;
  projectId: string;
}> {
  const projectId = Deno.env.get("FIREBASE_PROJECT_ID");
  const clientEmail = Deno.env.get("FIREBASE_CLIENT_EMAIL");
  const privateKey = Deno.env.get("FIREBASE_PRIVATE_KEY");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("Firebase service account secrets are missing");
  }

  const now = Math.floor(Date.now() / 1000);

  const jwtHeader = {
    alg: "RS256",
    typ: "JWT",
  };

  const jwtPayload = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const unsignedJwt =
    base64UrlEncode(JSON.stringify(jwtHeader)) +
    "." +
    base64UrlEncode(JSON.stringify(jwtPayload));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyToPkcs8(privateKey),
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsignedJwt)
  );

  const signedJwt =
    unsignedJwt +
    "." +
    base64UrlEncode(new Uint8Array(signature));

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
        assertion: signedJwt,
      }),
    }
  );

  const tokenResponseText = await tokenResponse.text();

  let tokenResponseData: any = {};

  try {
    tokenResponseData = JSON.parse(tokenResponseText);
  } catch {
    tokenResponseData = {};
  }

  if (!tokenResponse.ok || !tokenResponseData.access_token) {
    throw new Error(
      `Firebase OAuth failed (${tokenResponse.status})`
    );
  }

  return {
    accessToken: tokenResponseData.access_token,
    projectId,
  };
}

function getFcmErrorCode(responseData: any): string {
  const details = Array.isArray(responseData?.error?.details)
    ? responseData.error.details
    : [];

  const fcmError = details.find(
    (detail: any) =>
      typeof detail?.errorCode === "string"
  );

  return (
    fcmError?.errorCode ||
    responseData?.error?.status ||
    ""
  );
}

async function sendAdminPushNotifications(
  supabase: any,
  order: any
) {
  const { data: pushTokens, error: pushTokensError } =
    await supabase
      .from("push_tokens")
      .select("id, token");

  if (pushTokensError) {
    throw new Error(
      `Could not read push tokens: ${pushTokensError.message}`
    );
  }

  if (!pushTokens || pushTokens.length === 0) {
    console.log("FCM: no registered admin devices");
    return;
  }

  const { accessToken, projectId } =
    await getFirebaseAccessToken();

  const title = "🛒 New TICK Order";

  const body =
    `Order #${order.id} • ` +
    `${order.total_amount} EGP • ` +
    `${order.customer_name}`;

  const results = await Promise.allSettled(
  pushTokens.map(async (pushToken: any) => {
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(
        projectId
      )}/messages:send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token: pushToken.token,

            notification: {
              title,
              body,
            },

            data: {
              title,
              body,
              url: "/admin",
              orderId: String(order.id),
              totalAmount: String(order.total_amount ?? ""),
              customerName: String(order.customer_name ?? ""),
            },

            webpush: {
              headers: {
                Urgency: "high",
              },

              notification: {
                title,
                body,
                tag: `tick-order-${order.id}`,
                renotify: true,
                requireInteraction: true,
              },
            },
          },
        }),
      }
    );

    const responseText = await response.text();

      let responseData: any = {};

      try {
        responseData = JSON.parse(responseText);
      } catch {
        responseData = {};
      }

      if (!response.ok) {
        const errorCode = getFcmErrorCode(responseData);

        if (
          errorCode === "UNREGISTERED" ||
          errorCode === "NOT_FOUND"
        ) {
          const { error: deleteError } = await supabase
            .from("push_tokens")
            .delete()
            .eq("id", pushToken.id);

          if (deleteError) {
            console.error(
              "Could not remove expired FCM token:",
              deleteError.message
            );
          }

          console.warn(
            "FCM: removed expired admin device token"
          );

          return {
            sent: false,
            removed: true,
          };
        }

        throw new Error(
          `FCM send failed (${response.status}): ${errorCode || "unknown_error"}`
        );
      }

      return {
        sent: true,
        removed: false,
      };
    })
  );

  let sent = 0;
  let removed = 0;
  let failed = 0;

  for (const result of results) {
    if (result.status === "fulfilled") {
      if (result.value.sent) sent += 1;
      if (result.value.removed) removed += 1;
    } else {
      failed += 1;
      console.error(
        "FCM device send failed:",
        result.reason
      );
    }
  }

  console.log(
    `FCM RESULT: sent=${sent}, removed=${removed}, failed=${failed}`
  );
}

async function sendOrderEmail(order: any, items: any[]) {
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const adminEmail = Deno.env.get("ADMIN_EMAIL");

  if (!resendApiKey || !adminEmail) {
    console.warn(
      "RESEND_API_KEY or ADMIN_EMAIL is missing"
    );
    return;
  }

  const itemsHtml = items
    .map(
      (item: any) => `
        <li>
          Product ID: ${escapeHtml(item.pid)}<br>
          Qty: ${escapeHtml(item.qty)}<br>
          Price: ${escapeHtml(item.price)} EGP
        </li>
      `
    )
    .join("");

  const html = `
    <h2>🛒 New TICK Order</h2>

    <p><strong>Customer:</strong> ${escapeHtml(order.customer_name)}</p>
    <p><strong>Phone:</strong> ${escapeHtml(order.customer_phone)}</p>
    <p><strong>Email:</strong> ${escapeHtml(order.customer_email || "-")}</p>
    <p><strong>Payment:</strong> ${escapeHtml(order.payment_method)}</p>
    <p><strong>Total:</strong> ${escapeHtml(order.total_amount)} EGP</p>

    <hr>

    <h3>Items</h3>

    <ul>
      ${itemsHtml}
    </ul>

    <hr>

    <pre>${escapeHtml(
      JSON.stringify(order.shipping_address, null, 2)
    )}</pre>
  `;

  const response = await fetch(
    "https://api.resend.com/emails",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "TICK <onboarding@resend.dev>",
        to: adminEmail,
        subject: `🛒 New Order #${order.id}`,
        html,
      }),
    }
  );

  await response.text();

  console.log("RESEND STATUS:", response.status);

  if (!response.ok) {
    throw new Error(
      `Resend failed (${response.status})`
    );
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
    });
  }

  try {
    const requestBody = await req.json().catch(() => null);

const orderData = requestBody?.orderData;
const items = Array.isArray(requestBody?.items)
  ? requestBody.items
  : [];

if (
  !orderData ||
  typeof orderData !== "object" ||
  !orderData.customer ||
  typeof orderData.customer !== "object" ||
  typeof orderData.checkoutToken !== "string" ||
  orderData.checkoutToken.trim() === "" ||
  orderData.checkoutToken.length > 128
) {
  return new Response(
    JSON.stringify({
      ok: false,
      error: "invalid_request_body",
      message:
        "Request must contain orderData, orderData.customer, and items.",
    }),
    {
      status: 400,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    }
  );
}

if (
  orderData.total === undefined ||
  orderData.total === null ||
  !Number.isFinite(Number(orderData.total))
) {
  return new Response(
    JSON.stringify({
      ok: false,
      error: "invalid_order_total",
    }),
    {
      status: 400,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    }
  );
}
if (items.length === 0) {
  return new Response(
    JSON.stringify({
      ok: false,
      error: "empty_order_items",
      message: "An order must contain at least one item.",
    }),
    {
      status: 400,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    }
  );
}

const invalidItem = items.find((item: any) => {
  const quantity = Number(item?.qty);
  const price = Number(item?.price);

  return (
    !item ||
    typeof item !== "object" ||
    typeof item.pid !== "string" ||
    item.pid.trim() === "" ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    !Number.isFinite(price) ||
    price < 0
  );
});

if (invalidItem) {
  return new Response(
    JSON.stringify({
      ok: false,
      error: "invalid_order_item",
      message:
        "Every item must have a valid product ID, quantity, and price.",
    }),
    {
      status: 400,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    }
  );
}
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: order, error: orderError } =
  await supabase.rpc(
    "create_order_with_stock",
    {
      p_order: orderData,
      p_items: items,
    }
  );

if (orderError) {
  console.error(
    "create_order_with_stock failed:",
    orderError.message
  );

  const knownClientErrors = [
    "empty_order_items",
    "invalid_order_item",
    "invalid_item_quantity",
    "invalid_order_total",
    "invalid_order_data",
    "invalid_customer_data",
    "product_not_found",
    "insufficient_stock",
    "order_total_changed",
  ];

  const errorCode =
    knownClientErrors.includes(orderError.message)
      ? orderError.message
      : "order_creation_failed";

  const status =
    errorCode === "insufficient_stock" || errorCode === "order_total_changed"
      ? 409
      : errorCode === "product_not_found"
        ? 404
        : errorCode === "order_creation_failed"
          ? 500
          : 400;

  return new Response(
    JSON.stringify({
      ok: false,
      error: errorCode,
      message:
        errorCode === "insufficient_stock"
          ? "One or more products do not have enough stock."
          : errorCode === "order_total_changed"
            ? "A product price changed. Please refresh your cart and try again."
          : errorCode === "product_not_found"
            ? "One or more products are no longer available."
            : errorCode === "order_creation_failed"
              ? "The order could not be created."
              : "The order data is invalid.",
    }),
    {
      status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    }
  );
}

if (!order?.id) {
  return new Response(
    JSON.stringify({
      ok: false,
      error: "order_creation_failed",
      message: "No order ID was returned.",
    }),
    {
      status: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    }
  );
}
    /*
      إرسال الإيميل والـ Push بالتوازي.

      لو واحدة منهم فشلت، الأوردر يظل ناجحًا
      لأنه بالفعل اتحفظ في قاعدة البيانات.
    */
    const notificationResults =
      await Promise.allSettled([
        sendOrderEmail(order, items || []),
        sendAdminPushNotifications(
          supabase,
          order
        ),
      ]);

    if (
      notificationResults[0].status === "rejected"
    ) {
      console.error(
        "Order email failed:",
        notificationResults[0].reason
      );
    }

    if (
      notificationResults[1].status === "rejected"
    ) {
      console.error(
        "Order push failed:",
        notificationResults[1].reason
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        order,
        items: items.length,
      }),
      {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: String(error),
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }
});
