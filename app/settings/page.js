import { redirect } from 'next/navigation';
import Settings from '@/components/Settings';
import { isAuthed } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  // Same defense-in-depth gate as the home page.
  if (!(await isAuthed())) redirect('/login');
  return <Settings />;
}
