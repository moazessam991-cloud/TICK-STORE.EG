-- TICK. Supabase Schema
-- Relational structure for an online store with Auth and RLS

-- 1. Enable Required Extensions
create extension if not exists "uuid-ossp";

-- 2. Profiles Table (Extends Auth.Users)
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  full_name text,
  phone text,
  avatar_url text,
  role text default 'customer' check (role in ('customer', 'admin')),
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 3. Categories
create table public.categories (
  id uuid default uuid_generate_v4() primary key,
  name text not null,
  slug text unique not null,
  description text,
  image_url text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 4. Products
create table public.products (
  id uuid default uuid_generate_v4() primary key,
  category_id uuid references public.categories(id),
  brand text not null,
  name text not null,
  price numeric not null,
  sale_price numeric,
  emoji text,
  bg_color text,
  tags text[],
  size text,
  movement text,
  case_size text,
  crystal text,
  water_resistance text,
  strap_type text,
  power_reserve text,
  stock_quantity integer default 0,
  description_en text,
  description_ar text,
  video_url text,
  model_3d_url text,
  is_active boolean default true,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 5. Product Images
create table public.product_images (
  id uuid default uuid_generate_v4() primary key,
  product_id uuid references public.products(id) on delete cascade,
  url text not null,
  display_order integer default 0,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 6. Carts & Cart Items
create table public.carts (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references auth.users(id) on delete cascade unique,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create table public.cart_items (
  id uuid default uuid_generate_v4() primary key,
  cart_id uuid references public.carts(id) on delete cascade,
  product_id uuid references public.products(id) on delete cascade,
  quantity integer default 1,
  metadata jsonb, -- For strap variants, etc.
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 7. Wishlist
create table public.wishlist (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references auth.users(id) on delete cascade,
  product_id uuid references public.products(id) on delete cascade,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique(user_id, product_id)
);

-- 8. Orders & Order Items
create table public.orders (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references auth.users(id) on delete set null,
  status text default 'pending' check (status in ('pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'refunded')),
  total_amount numeric not null,
  payment_method text,
  payment_status text default 'unpaid',
  payment_id text, -- Paymob transaction ID
  customer_name text,
  customer_phone text,
  customer_email text,
  shipping_address jsonb,
  notes text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create table public.order_items (
  id uuid default uuid_generate_v4() primary key,
  order_id uuid references public.orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  quantity integer not null,
  price_at_purchase numeric not null,
  metadata jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 9. Reviews
create table public.reviews (
  id uuid default uuid_generate_v4() primary key,
  product_id uuid references public.products(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  rating integer check (rating >= 1 and rating <= 5),
  customer_name text,
  comment text,
  is_verified boolean default false,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 10. Coupons
create table public.coupons (
  id uuid default uuid_generate_v4() primary key,
  code text unique not null,
  discount_type text check (discount_type in ('percentage', 'fixed')),
  discount_value numeric not null,
  min_order_amount numeric default 0,
  expires_at timestamp with time zone,
  usage_limit integer,
  usage_count integer default 0,
  is_active boolean default true,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 11. Banners
create table public.banners (
  id uuid default uuid_generate_v4() primary key,
  title text,
  image_url text not null,
  link_url text,
  display_order integer default 0,
  is_active boolean default true,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 12. Learn Episodes (Specific to TICK. workflow)
create table public.episodes (
  id uuid default uuid_generate_v4() primary key,
  episode_number integer not null,
  title_en text not null,
  title_ar text not null,
  description_en text,
  description_ar text,
  category text,
  duration text,
  video_url text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 13. Straps (Specific to TICK. workflow)
create table public.straps (
  id uuid default uuid_generate_v4() primary key,
  name text not null,
  icon text,
  base_price numeric not null,
  colors jsonb, -- Array of {n, h}
  widths text[],
  stock_quantity integer default 0,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 14. Settings (Global Config)
create table public.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 15. Notify Me (Back in stock)
create table public.notify_me (
  id uuid default uuid_generate_v4() primary key,
  product_id uuid references public.products(id) on delete cascade,
  email text,
  phone text,
  contact_raw text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 16. Audit Log
create table public.audit_log (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references auth.users(id) on delete set null,
  action text not null,
  detail text,
  ts timestamp with time zone default timezone('utc'::text, now()) not null
);

-- ─── ROW LEVEL SECURITY (RLS) POLICIES ───

-- Enable RLS on all tables
alter table public.profiles enable row level security;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.product_images enable row level security;
alter table public.carts enable row level security;
alter table public.cart_items enable row level security;
alter table public.wishlist enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.reviews enable row level security;
alter table public.coupons enable row level security;
alter table public.banners enable row level security;
alter table public.episodes enable row level security;
alter table public.straps enable row level security;
alter table public.settings enable row level security;
alter table public.notify_me enable row level security;
alter table public.audit_log enable row level security;

-- Helper function to check if user is admin
create or replace function public.is_admin()
returns boolean as $$
begin
  return (
    select (role = 'admin')
    from public.profiles
    where id = auth.uid()
  );
end;
$$ language plpgsql security definer;

-- Profiles: Users can view/edit their own profile. Admins can view all.
create policy "Public profiles are viewable by everyone." on public.profiles for select using ( true );
create policy "Users can update own profile." on public.profiles for update using ( auth.uid() = id );

-- Categories & Products: Viewable by everyone. Modifiable by admins.
create policy "Categories are viewable by everyone." on public.categories for select using ( true );
create policy "Admins can manage categories." on public.categories for all using ( public.is_admin() );

create policy "Products are viewable by everyone." on public.products for select using ( true );
create policy "Admins can manage products." on public.products for all using ( public.is_admin() );

create policy "Product images are viewable by everyone." on public.product_images for select using ( true );
create policy "Admins can manage product images." on public.product_images for all using ( public.is_admin() );

-- Carts: Users manage their own cart.
create policy "Users can manage their own cart." on public.carts for all using ( auth.uid() = user_id );
create policy "Users can manage their own cart items." on public.cart_items for all using (
  exists (select 1 from public.carts where id = cart_items.cart_id and user_id = auth.uid())
);

-- Wishlist: Users manage their own wishlist.
create policy "Users can manage their own wishlist." on public.wishlist for all using ( auth.uid() = user_id );

-- Orders: Users can create and view their own. Admins can view all.
create policy "Users can create orders." on public.orders for insert with check ( auth.uid() = user_id or auth.uid() is null );
create policy "Users can view own orders." on public.orders for select using ( auth.uid() = user_id or public.is_admin() );
create policy "Admins can update orders." on public.orders for update using ( public.is_admin() );

create policy "Users can view own order items." on public.order_items for select using (
  exists (select 1 from public.orders where id = order_items.order_id and (user_id = auth.uid() or public.is_admin()))
);

-- Reviews: Everyone can view. Authenticated users can create.
create policy "Reviews are viewable by everyone." on public.reviews for select using ( true );
create policy "Authenticated users can create reviews." on public.reviews for insert with check ( auth.role() = 'authenticated' );
create policy "Admins can manage reviews." on public.reviews for all using ( public.is_admin() );

-- Coupons, Banners, Straps, Episodes: Everyone can view. Admins manage.
create policy "Public viewable tables." on public.coupons for select using ( true );
create policy "Admins manage coupons." on public.coupons for all using ( public.is_admin() );

create policy "Banners viewable." on public.banners for select using ( true );
create policy "Admins manage banners." on public.banners for all using ( public.is_admin() );

create policy "Straps viewable." on public.straps for select using ( true );
create policy "Admins manage straps." on public.straps for all using ( public.is_admin() );

create policy "Episodes viewable." on public.episodes for select using ( true );
create policy "Admins manage episodes." on public.episodes for all using ( public.is_admin() );

-- Settings: Only admins.
create policy "Admins manage settings." on public.settings for all using ( public.is_admin() );

-- Notify Me: Public insert, Admin view.
create policy "Anyone can subscribe to notifications." on public.notify_me for insert with check ( true );
create policy "Admins manage notifications." on public.notify_me for all using ( public.is_admin() );

-- Audit Log: Admin view only.
create policy "Admins can view audit logs." on public.audit_log for select using ( public.is_admin() );

-- 17. Triggers for Profile creation on Auth Signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, full_name, avatar_url, role)
  values (new.id, new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'avatar_url', 'customer');
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
