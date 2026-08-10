// Keep focus inside a modal while it's open — attach as onKeyDown on the dialog
// element. Shared by the Calendar modals and ScheduleManager (don't fork copies).
export function trapTab(e) {
  if (e.key !== 'Tab') return;
  // Skip disabled controls: a disabled first/last makes .focus() a no-op after
  // preventDefault(), so Tab would stick instead of wrapping (IB-12).
  const f = [
    ...e.currentTarget.querySelectorAll(
      'input, select, button, textarea, [tabindex]:not([tabindex="-1"])'
    ),
  ].filter((el) => !el.disabled);
  if (!f.length) return;
  const first = f[0];
  const last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
