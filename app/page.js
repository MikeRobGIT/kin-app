import { redirect } from 'next/navigation';
import Calendar from '@/components/Calendar';
import { isAuthed } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function Home() {
  // Defense-in-depth: don't rely on the proxy alone to gate this page
  // (network-edge gating can be bypassed). Verify the HMAC here too.
  if (!(await isAuthed())) redirect('/login');
  return <Calendar />;
}
