import { redirect } from 'next/navigation';
import Report from '@/components/Report';
import { isAuthed } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function ReportPage() {
  // Same defense-in-depth gate as the home page.
  if (!(await isAuthed())) redirect('/login');
  return <Report />;
}
