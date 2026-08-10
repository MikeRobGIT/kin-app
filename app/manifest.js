// App Router metadata route — served at /manifest.webmanifest and auto-linked
// in <head>. Must stay on the proxy.js allowlist: the browser fetches it (and
// the icons it references) without a session, e.g. during home-screen install.
export default function manifest() {
  return {
    name: 'Kin',
    short_name: 'Kin',
    description: 'Self-hosted family care & involvement tracker',
    start_url: '/',
    display: 'standalone',
    background_color: '#f6f2ea',
    theme_color: '#c8553d',
    icons: [
      { src: '/icon.svg', type: 'image/svg+xml', sizes: 'any' },
      { src: '/apple-icon.png', type: 'image/png', sizes: '180x180' },
    ],
  };
}
