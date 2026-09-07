/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Media is served via Supabase Storage / Cloudflare CDN signed URLs.
  // Add remote patterns here when wiring next/image to the storage host.
  images: { remotePatterns: [] },
  async headers() {
    return [
      {
        // FRI-21: the worker script must never be served from a stale HTTP
        // cache. Browsers re-check /sw.js on navigation, and that check is
        // how a fix — or the RUNBOOK kill switch — reaches phones that
        // already have a worker installed. `max-age=0, must-revalidate` keeps
        // that path honest. `Service-Worker-Allowed: /` lets the worker take
        // root scope even though only /e/* navigations are handled.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
