/**
 * Baseline security headers for every response. No inline-script CSP is set here on purpose: Next.js
 * injects inline bootstrap scripts, and a strict CSP would need per-request nonces. These headers cover
 * clickjacking, MIME sniffing, referrer leakage and unneeded browser features.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // API responses are live data and carry no cookies: never let a shared cache keep them.
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};
export default nextConfig;
