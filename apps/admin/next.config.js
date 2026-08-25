/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@envoy/sdk", "@envoy/types"],
  reactStrictMode: true,
};

export default nextConfig;
