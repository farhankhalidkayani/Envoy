/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship TS source, not a prebuilt dist — Next needs to
  // transpile them itself rather than treating them as opaque node_modules.
  transpilePackages: ["@envoy/sdk", "@envoy/types"],
  reactStrictMode: true,
};

export default nextConfig;
