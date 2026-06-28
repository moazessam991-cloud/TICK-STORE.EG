# TICK. Supabase & Paymob Connection Guide

This guide details how to finalize the connection between your online store and Supabase/Paymob.

## 1. Supabase Project Setup
1. Create a new project at [supabase.com](https://supabase.com).
2. Go to the **SQL Editor** in your Supabase dashboard.
3. Copy the contents of `supabase_schema.sql` (found in this repo) and run it. This will create all tables, RLS policies, and triggers.
4. Go to **Project Settings > API** and copy your `Project URL` and `anon public` key.
5. Open `public/supabase-client.js` in this project and replace `YOUR_SUPABASE_URL` and `YOUR_SUPABASE_ANON_KEY` with your project credentials.

## 2. Authentication
- Supabase Auth is already enabled by default.
- In the Supabase Dashboard, go to **Authentication > Providers** and ensure "Email" is enabled.
- (Optional) Configure "Confirm Email" to true for production security.

## 3. Storage
1. Go to **Storage** in Supabase.
2. Create the following public buckets:
   - `products`
   - `avatars`
   - `banners`
3. Ensure the policies allow public read access (the SQL schema includes RLS for tables, but buckets need UI configuration).

## 4. Paymob Integration (Edge Functions)
1. Install the Supabase CLI on your local machine: `npm install -g supabase`.
2. Login: `supabase login`.
3. Link your project: `supabase link --project-ref your-project-id`.
4. Deploy the functions: `supabase functions deploy`.
5. Set your Paymob secrets in Supabase:
   ```bash
   supabase secrets set PAYMOB_API_KEY=your_api_key
   supabase secrets set PAYMOB_INTEGRATION_ID=your_id
   supabase secrets set PAYMOB_IFRAME_ID=your_id
   supabase secrets set PAYMOB_HMAC_SECRET=your_hmac_secret
   ```

## 5. Paymob Dashboard
1. Log in to your Paymob dashboard.
2. Go to **Settings > Integrations**.
3. Set the **Transaction processed callback** to:
   `https://your-project-ref.supabase.co/functions/v1/paymob-webhook`

## 6. Testing
- Open `index.html` (via a local server like `npx serve public`).
- The store will now fetch data directly from Supabase.
- Add some products via the Supabase Dashboard UI or use the Admin panel in the store (if you set your profile role to 'admin' in the `profiles` table).

**Note:** The Node.js server in `server/` is no longer required for the store's operation. You can eventually decommission it after confirming all data has migrated to Supabase.
