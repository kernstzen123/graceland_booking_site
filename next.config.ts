import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow the current ngrok hostname to load the Next.js development HMR
  // resources when testing PayFast through the public tunnel.
  allowedDevOrigins: ['droplet-headless-karaoke.ngrok-free.dev'],
};

export default nextConfig;
