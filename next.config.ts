import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // If you need to test via an ngrok tunnel on mobile during development,
  // set NGROK_HOST in .env.local (e.g. "your-subdomain.ngrok-free.dev").
  // This is only used in development; production builds ignore it.
  ...(process.env.NODE_ENV !== 'production' && process.env.NGROK_HOST
    ? { allowedDevOrigins: [process.env.NGROK_HOST] }
    : {}),
};

export default nextConfig;
