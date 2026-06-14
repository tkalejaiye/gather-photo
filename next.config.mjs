/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Media is served via Supabase Storage / Cloudflare CDN signed URLs.
  // Add remote patterns here when wiring next/image to the storage host.
  images: { remotePatterns: [] },
};

export default nextConfig;
