# Kin — Multi-User Product Design

**Date:** 2026-06-12
**Status:** Approved direction; pre-implementation design
**Scope:** The architecture and product design for turning Kin (single-user, self-hosted)
into an official multi-user app. This document designs the product; implementation is
phased separately (see §8).

---

## 1. Context & goals

Kin today is a single-user, self-hosted family-care tracker: one password, one SQLite
file, one family. It is live at kin.example.com as the owner's personal custody record and
**stays untouched** — the product is built in parallel on a new foundation, and the
existing instance keeps serving its legal-record purpose without churn.

**Product thesis:** parents — especially those heading into custody disputes — need a
credible, contemporaneous record of their day-to-day involvement with their kids.
Existing co-parenting apps (OurFamilyWizard, TalkingParents) are *communication* tools
that require both parents to participate. Kin is an *involvement record* that works for
**one parent alone**, with sharing strictly optional.

### Locked decisions

| Decision | Choice |
|---|---|
| Foundation | **MakerKit** (licensed) — Next.js + Supabase SaaS starter |
| Deployment target | SaaS-ready architecture; first deployment private on own infra |
| Sharing model | **Owner + private record by default; shared family optional** — inviting a co-parent is never required |
| Onboarding | Guided setup wizard |
| Auth | Email + password + magic link (MakerKit/Supabase auth); OAuth later |
| Existing app | Keeps running unchanged at kin.example.com |

---

## 2. Product model

### 2.1 Core concepts

- **User** — an account (email + password / magic link). MakerKit personal account.
- **Family** — the tenant. Maps to a MakerKit **team account**. All Kin data
  (children, events, caregivers) belongs to exactly one family. A user can belong to
  multiple families (e.g. a grandparent helping two households), though that's an edge
  case, not a design driver.
- **Member** — a user with a role in a family (see roles below).
- **Caregiver** — a *named person* in the family's "Done by" list. **Caregivers are not
  members.** This is the load-bearing design distinction:
  - The owner can log "Mom made dinner" without Mom ever having an account or knowing
    the app exists (today's exact usage, preserved).
  - `caregivers.user_id` is nullable. If that person later joins as a member, their
    caregiver row links to their account and their own entries are attributed to them.
- **Child** — belongs to a family; name + color, as today.

### 2.2 Roles (v1)

| Role | Calendar | Log entries | Reports & export | Invites, family settings, billing |
|---|---|---|---|---|
| **Owner** | ✓ | ✓ | ✓ | ✓ |
| **Co-parent** | ✓ | ✓ | ✓ | ✗ |
| **Helper** (grandparent, sitter) | ✓ | ✓ | ✗ | ✗ |

- A **solo family is fully functional** — the owner never has to invite anyone.
- v1 visibility is deliberately simple: *if you invite someone, they see the family
  calendar*. Per-entry privacy ("private notes only I can see") is explicitly **v2** —
  it doubles the permission surface and the v1 answer for a litigation-posture user is
  "don't invite the other parent."
- Read-only **Viewer** role (e.g. attorney access) is v2.

### 2.3 Credibility features — the differentiator

For a record that may be shown in court, credibility is the product. Carried over and
extended from the current app:

1. **Immutable `recorded_at`** — server-set on creation, never updatable, always shown
   in reports beside the event date (already the current behavior).
2. **Append-only edit history** — `event_revisions` stores every prior state of an
   edited or deleted event. Reports can disclose "edited on …" so the record shows
   nothing was silently altered.
3. **Attribution** — `created_by` (user) on every entry; in shared families each
   member's entries are provably theirs.
4. **Backfill labeling** — bulk-backfilled entries are normal entries (current
   decision), but the product surfaces their `recorded_at` honestly and the report's
   methodology note explains the distinction between event date and recording date.
5. **The report stays self-described**: "self-reported log; each entry shows when it
   was recorded" — honest framing is more credible than pretending to be a notary.

---

## 3. Architecture

### 3.1 Foundation: MakerKit + Supabase

MakerKit supplies the undifferentiated SaaS plumbing — auth (email/password, magic
link, OAuth-ready), personal + team accounts, memberships and invitations, Stripe
billing, transactional email, settings UI, and a Next.js App Router structure. Kin's
domain (calendar, report, AI) is built as features inside it.

- **Tenant mapping:** MakerKit team account = Kin family. Invitation/role machinery is
  MakerKit's, with Kin's three roles configured on top.
- **Database:** Supabase **Postgres** with **Row-Level Security**. This answers the
  earlier "separate database?" question for the product: multi-tenant + concurrent
  writers is exactly when Postgres earns its keep. (The personal instance stays on
  SQLite; both answers are right for their context.)
- **Data access:** server actions / route handlers using Supabase clients; **RLS
  policies are the tenancy boundary** (every Kin table carries the family/team id and
  policies restrict to memberships). Cross-tenant leakage is prevented in the database,
  not by application discipline.

### 3.2 Kin domain schema (Postgres)

MakerKit-owned tables (users, accounts, memberships, invitations, subscriptions) are
used as-is. Kin adds:

```
children        id, family_id (team account FK), name, color, sort, created_at
caregivers      id, family_id, name, color, sort, user_id NULLABLE (FK users)
events          id, family_id, child_id FK, caregiver_id NULLABLE FK,
                type TEXT, pd TEXT, date DATE, time TIME, title, who, notes,
                created_by FK users, created_at (immutable), updated_at
event_revisions id, event_id FK, family_id, snapshot JSONB, action
                ('update'|'delete'), acted_by FK users, acted_at
```

- The **types taxonomy ports verbatim** from `lib/constants.js` (transport + caregiving
  groups, `trip` flag driving the pickup/drop-off selector and validation). It stays
  application-level constants, not a DB table — same reasoning as today.
- Validation rules port from the current route handlers (type whitelist, pd only for
  trip types, date/time formats, child/caregiver existence) into the server actions.
- `event_revisions` is insert-only (no UPDATE/DELETE grants) — the audit trail.

### 3.3 Ported features

Everything user-facing carries over; the foundation underneath changes.

| Feature | Port notes |
|---|---|
| Calendar (week/day/month), chips, modal CRUD | Components port nearly as-is; data calls become server actions under RLS |
| Done-by + trip selector behavior | Unchanged (`isTrip` logic) |
| Involvement report (tallies, % split, chronological log, CSV, print) | Unchanged logic; gains edit-history disclosure (§2.3) |
| AI quick-add | Parse prompt + sanitation port verbatim from `app/api/parse/route.js` |
| Recurring backfill | Rule → `expandDates` (port verbatim) → deselectable preview → bulk insert in one transaction |

**AI in the product:** platform-provided LiteLLM endpoint (our keys), with per-family
rate limits, a clear disclosure ("entries you type are processed by an AI model"), and
an **opt-in toggle** at onboarding (default off until accepted). Self-hosted
deployments point `LITELLM_*` at their own endpoint, as today.

---

## 4. Onboarding wizard

Guided multi-step wizard (locked decision), with a hard budget: **≤ 3 minutes; after
sign-up, every step is skippable except children**. Progress indicator throughout.

1. **Sign up** — email + password or magic link (MakerKit screen, Kin-branded).
2. **Your family** — family name (prefilled suggestion; rename anytime).
3. **Your kids** — name + color per child; at least one required (the app is
   meaningless without a child); add more later from settings.
4. **Who does the caring?** — caregiver list. "You" is pre-added and linked to the
   account. Prompt to add the other parent and helpers **as names** — with explicit
   copy: *"This just adds them to your 'done by' list. It does not contact them or give
   them access."* (The owner-private model must be legible at this exact moment.)
5. **Optional: invite someone** — invite a co-parent or helper by email, with
   **"Just me for now"** as the visually primary action. Copy reassures: *"Kin works
   fully solo. You can invite someone later — or never."*
6. **AI consent** — one screen: what quick-add does, where text goes, opt in/out.
7. **First entry** — guided quick-add with a prefilled example using their actual
   child's name ("I took Maya to school today") → parses → they confirm in the modal →
   land on the calendar with their first real entry visible.

Post-onboarding empty states carry the teaching load thereafter (e.g. empty report
explains what it will show once entries exist).

---

## 5. Migration from personal Kin

A one-time import for the founder instance (and any future self-host converts): export
`children`, `caregivers`, `events` from `tracker.db` (SQLite) → import into a family,
mapping `g1/g2` caregivers and preserving `created_at` values (with the import itself
recorded in `event_revisions` as provenance, so even the migration is honest).
Implemented as a small script in P3 — not a product feature in v1's UI.

---

## 6. Monetization sketch (directional, not committed)

MakerKit ships Stripe billing; tiers configured there.

| | Free | Kin Plus (~$8–12/mo) |
|---|---|---|
| Children | up to 2 | unlimited |
| Manual logging + calendar | ✓ | ✓ |
| Report | current month | full history + CSV/print |
| AI quick-add + backfill | — | ✓ |
| Co-parent / helpers | — | ✓ |

Principle: the *record itself* is never held hostage (export of your own data is always
available — both ethically and for GDPR/CCPA compliance).

---

## 7. Legal & trust (work items, pre-public-launch)

- Privacy policy + ToS; data about children (COPPA/GDPR-K review — the *users* are
  adults, but the data concerns minors).
- Data export (full-family JSON/CSV) and account/family deletion flows.
- Encryption at rest (Supabase default) + backups; document retention policy.
- AI disclosure (§3.3) and a subprocessor list.
- Position the report's legal framing carefully: *a self-reported contemporaneous log*,
  not certified evidence. No legal-advice claims anywhere in product copy.

---

## 8. Rollout phases

Each phase gets its own spec → plan → implementation cycle; this document is the
umbrella.

- **P0 — Spike (days):** stand up MakerKit + Supabase locally; confirm the licensed
  kit's version/stack; map team account → family; one RLS-protected `children` table
  end-to-end. Output: go/no-go + corrections to this design.
- **P1 — Domain core:** full schema + RLS; calendar (3 views) + event CRUD + types;
  report with tallies/log/CSV; `event_revisions` capture.
- **P2 — Multi-user surface:** onboarding wizard; invitations + the three roles;
  family settings (kids, caregivers, rename).
- **P3 — Product polish:** AI quick-add + recurring backfill (ported); import from
  personal Kin; billing tiers wired; legal pages; **private beta** deployed on own
  infra (Coolify + Supabase) with a handful of invited users.
- **P4 — Public SaaS:** marketing site, signup opened, support channel. Gated on beta
  feedback.

---

## 9. Open questions (tracked, non-blocking)

1. **MakerKit license specifics** — which kit/version does the license cover
   (next-supabase-saas-kit-turbo presumed)? Confirm in P0.
2. **Public self-host distribution** — MakerKit's license prohibits public source
   redistribution, which tensions with a community self-host edition. Phase A
   ("self-host first") is satisfied by the private own-infra deployment; a public
   self-host story (separate OSS core? container-only distribution?) is deferred.
3. **Supabase hosted vs self-hosted** for production — custody data sovereignty argues
   for self-hosted on own infra; operational simplicity argues hosted. Decide by P3.
4. **Name check** — "Kin" is short and crowded (Kin insurance, others). Trademark/
   domain scan before any branding spend; product can rename cheaply before P4.
5. **Helper report access** — v1 says no; revisit with beta feedback.
6. **Pricing** — §6 is directional; decide at P3 with real cost data (AI per-family
   cost especially).

---

## 10. What this design explicitly does *not* change

- The live kin.example.com instance (SQLite, single-password) — untouched, indefinitely.
- The transport-tracker repo's dependency-light constraints — they apply to the
  personal app; the product lives in a **new repository** on MakerKit's stack.
- The decision that backfilled entries are normal entries — carried into the product,
  with the honesty mechanics of §2.3.
