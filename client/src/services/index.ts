/**
 * ============================================================================================
 *  THE SERVICE SWITCH — the only entry point to data in the client.
 *
 *  ✗ Components and pages must NOT import from /mocks, services/mock or services/http.
 *  ✓ Components use the TanStack Query hooks in features/<domain>/hooks.ts;
 *    hooks (and AuthContext) use the `services` object exported here.
 *
 *  Enforced by src/services/boundaries.test.ts, which fails the test suite on a violation.
 *
 *  Adapter per domain comes from VITE_USE_MOCKS (parsed once, at module load):
 *    all                       every domain uses services/mock (offline UI work; accounts vanish on reload)
 *    none                      every domain uses services/http
 *    auth,lectures,transcript  only the listed domains are mocked; the rest use http
 *  Domains: auth, lectures, transcript, topics, summaries, search, qa, quizzes, revision.
 *  Unset: in development, DEV_DEFAULT_MOCKS (only the domains the server cannot answer yet);
 *  in a production build, `none` — fixture data must never ship as real data.
 * ============================================================================================
 */
import { httpServices } from './http';
import { mockServices } from './mock';
import { SERVICE_DOMAINS, type ServiceDomain, type Services } from './types';

export type { Services, ServiceDomain } from './types';
export * from './types';

/**
 * Domains whose server routes still answer 501 (Members A, B, C), mocked by default in development.
 * Everything else — auth and lectures — talks to the real API, so a registered account is really
 * saved. Remove a domain from this list when its module lands.
 */
export const DEV_DEFAULT_MOCKS = 'transcript,topics,summaries,search,qa,quizzes,revision';

/**
 * Parse a VITE_USE_MOCKS value into the set of mocked domains. Unknown names are ignored with a
 * warning. `fallback` applies when the variable is unset.
 */
export function parseMockFlag(raw: string | undefined, fallback = 'all'): Set<ServiceDomain> {
  const value = (raw ?? fallback).trim().toLowerCase();
  if (value === '' || value === 'all') return new Set(SERVICE_DOMAINS);
  if (value === 'none') return new Set();
  const mocked = new Set<ServiceDomain>();
  for (const name of value.split(',').map((s) => s.trim()).filter(Boolean)) {
    if ((SERVICE_DOMAINS as readonly string[]).includes(name)) mocked.add(name as ServiceDomain);
    else console.warn(`[services] VITE_USE_MOCKS: unknown domain "${name}" ignored. Valid: ${SERVICE_DOMAINS.join(', ')}`);
  }
  return mocked;
}

/** Build the services object for a set of mocked domains. */
export function selectServices(mocked: Set<ServiceDomain>): Services {
  const pick = <K extends ServiceDomain>(domain: K): Services[K] => (mocked.has(domain) ? mockServices : httpServices)[domain];
  return {
    auth: pick('auth'),
    lectures: pick('lectures'),
    transcript: pick('transcript'),
    topics: pick('topics'),
    summaries: pick('summaries'),
    search: pick('search'),
    qa: pick('qa'),
    quizzes: pick('quizzes'),
    revision: pick('revision'),
  };
}

export const mockedDomains: ReadonlySet<ServiceDomain> = parseMockFlag(
  import.meta.env.VITE_USE_MOCKS,
  import.meta.env.PROD ? 'none' : DEV_DEFAULT_MOCKS,
);

export const services: Services = selectServices(new Set(mockedDomains));

export { DEMO_ACCOUNTS, type DemoAccount } from './demoAccounts';

/** Show the "Demo accounts" block on /login: when auth is mocked, or when the seeded server is used for a demo. */
export const showDemoAccounts: boolean = mockedDomains.has('auth') || import.meta.env.VITE_SHOW_DEMO_ACCOUNTS === 'true';

if (import.meta.env.DEV && mockedDomains.size > 0) {
  console.info(`[services] Mock data for: ${[...mockedDomains].join(', ')}.`);
}
if (import.meta.env.DEV && mockedDomains.has('auth')) {
  // Say it loudly: with mocked auth nothing reaches the server or the database.
  console.warn(
    '[services] Auth is MOCKED (VITE_USE_MOCKS includes auth): accounts you register live in memory only, are never sent to the API or MongoDB, and vanish on reload. Demo login: teacher@lecturelens.dev or student@lecturelens.dev, password "lecturelens".',
  );
}
