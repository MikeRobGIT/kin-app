import './globals.css';

export const metadata = {
  title: 'Kin',
  description: 'Self-hosted family care & involvement tracker',
  // Full-screen when saved to an iPad home screen (kitchen kiosk).
  appleWebApp: { capable: true, title: 'Kin', statusBarStyle: 'black-translucent' },
};

// viewportFit:'cover' makes env(safe-area-inset-*) resolve to real values so the
// full-screen mobile modal sheet pads around the notch / home indicator.
export const viewport = { width: 'device-width', initialScale: 1, themeColor: '#f6f2ea', viewportFit: 'cover' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
