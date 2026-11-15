import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `npm run tunnel` serves the dev server on a random trycloudflare.com host for the phone.
  allowedDevOrigins: ["*.trycloudflare.com"],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
