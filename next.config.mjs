/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // better-sqlite3 is a native module; keep it external to the bundle
  serverExternalPackages: ['better-sqlite3'],
};

export default nextConfig;
