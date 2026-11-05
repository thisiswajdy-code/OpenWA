// Render test for the locked page a paid sign-up sees until an admin approves it, under the bare
// `node --test` runner. The page polls GET /auth/me and clears the lock in the role context the
// moment the gateway reports the account approved, so the dashboard unlocks with no second sign-in.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RoleContextType } from '../types/role';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

let pending = true;
let meStatus = 200;
let meCalls = 0;

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/auth/me') {
      meCalls += 1;
      if (meStatus !== 200) return Promise.resolve(jsonResponse({ message: 'nope' }, meStatus));
      return Promise.resolve(
        jsonResponse({ id: 'u2', email: 'dana@example.com', role: 'operator', pendingApproval: pending }),
      );
    }
    return Promise.resolve(jsonResponse({ message: `unstubbed ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let PendingApproval: (typeof import('./PendingApproval.tsx'))['PendingApproval'];
let RoleContext: (typeof import('../hooks/useRole.tsx'))['RoleContext'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleContext } = await import('../hooks/useRole.tsx'));
  ({ PendingApproval } = await import('./PendingApproval.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
  pending = true;
  meStatus = 200;
  meCalls = 0;
});

function renderPending(): { unlocked: boolean[] } {
  const unlocked: boolean[] = [];
  const role: RoleContextType = {
    role: 'operator',
    setRole: () => undefined,
    isAdmin: false,
    isOperator: true,
    isViewer: false,
    canWrite: true,
    engineType: 'baileys',
    setEngineType: () => undefined,
    scoped: false,
    setScoped: () => undefined,
    pendingApproval: true,
    setPendingApproval: value => unlocked.push(value),
  };
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleContext.Provider, { value: role }, createElement(PendingApproval)),
    ),
  );
  return { unlocked };
}

test('the lock names the account and stays locked while the gateway says pending', async () => {
  const { unlocked } = renderPending();
  await rtl.screen.findByText('Signed in as dana@example.com');
  assert.equal(rtl.screen.getByRole('heading', { level: 1 }).textContent, 'Pending approval');
  assert.deepEqual(unlocked, [], 'the page unlocked a pending account');
  // The pages behind the lock are never drawn: nothing on the page asks for sessions or chats.
  assert.equal(meCalls, 1);
});

test('Check again asks the gateway once more, and an approval clears the lock', async () => {
  const { unlocked } = renderPending();
  await rtl.screen.findByText('Signed in as dana@example.com');
  pending = false;
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Check again' }));
  await rtl.waitFor(() => assert.deepEqual(unlocked, [false]));
  assert.equal(meCalls, 2);
});

test('a failed status read is reported on the page, without unlocking', async () => {
  meStatus = 500;
  const { unlocked } = renderPending();
  await rtl.screen.findByText('The approval status could not be read. The page will try again.');
  assert.deepEqual(unlocked, []);
});
