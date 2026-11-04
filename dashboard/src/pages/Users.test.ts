// Render test for the Users page under the bare `node --test` runner, on the ApiKeys.test.ts
// harness. The page manages the dashboard users that sign in with email and password: the list
// never carries a password, and an edit sends only what changed, because a password, role or
// deactivation signs the user out everywhere.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, isValidEmail, userPatch } from '../utils/users.ts';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// The status GET /auth/users answers with: 200 lists `userList`.
let listStatus = 200;
const ops = {
  id: 'user-1',
  email: 'ops@example.com',
  role: 'operator',
  isActive: true,
  lastLoginAt: '2026-03-04T05:06:07.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
let userList: Record<string, unknown>[] = [ops];
let createBody: Record<string, unknown> | undefined;
let createStatus = 201;
let updateBodies: Record<string, unknown>[] = [];
let deleted: string[] = [];
let planBodies: Record<string, unknown>[] = [];
const plan = {
  description: 'Scalorus WA — 12 months',
  amount: 30,
  currencyCode: 'USD',
  paymentsNumber: 12,
  chargeFrequency: 'monthly',
  fallbackAmountIls: 95,
  total: 360,
  enabled: true,
};

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (init?.method === 'POST' && path === '/api/auth/users') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      createBody = body;
      if (createStatus === 409) {
        return Promise.resolve(jsonResponse({ message: `A user with email '${body.email}' already exists` }, 409));
      }
      return Promise.resolve(jsonResponse({ ...ops, id: 'user-new', email: body.email, lastLoginAt: undefined }, 201));
    }
    if (init?.method === 'PUT' && path.startsWith('/api/auth/users/')) {
      updateBodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(jsonResponse(ops));
    }
    if (init?.method === 'DELETE' && path.startsWith('/api/auth/users/')) {
      deleted.push(path.slice('/api/auth/users/'.length));
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (path === '/api/auth/signup-plan') {
      if (init?.method === 'PUT') {
        planBodies.push(JSON.parse(String(init.body)));
        const body = JSON.parse(String(init.body)) as Record<string, number>;
        return Promise.resolve(jsonResponse({ ...plan, ...body, total: body.amount * body.paymentsNumber }));
      }
      return Promise.resolve(jsonResponse(plan));
    }
    if (path === '/api/auth/users') {
      if (listStatus !== 200) {
        return Promise.resolve(jsonResponse({ message: 'This API key cannot access this resource' }, listStatus));
      }
      return Promise.resolve(jsonResponse(userList));
    }
    return Promise.resolve(jsonResponse({ message: `unstubbed ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Users: (typeof import('./Users.tsx'))['Users'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Users } = await import('./Users.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
  listStatus = 200;
  userList = [ops];
  createBody = undefined;
  createStatus = 201;
  updateBodies = [];
  deleted = [];
  planBodies = [];
});

function renderUsers(): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ToastProvider, null, createElement(Users)),
    ),
  );
}

test('a user row shows the email, role, status and last sign-in, and never a password', async () => {
  userList = [
    ops,
    { ...ops, id: 'user-2', email: 'old@example.com', role: 'viewer', isActive: false, lastLoginAt: undefined },
  ];
  renderUsers();
  await rtl.screen.findByText('ops@example.com');
  const rows = Array.from(document.querySelectorAll('tbody tr'));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].querySelector('.permission-badge')?.textContent, 'operator');
  assert.equal(rows[0].querySelector('.status-badge')?.textContent, 'Active');
  assert.equal(rows[0].querySelector('.last-sign-in')?.textContent, new Date(ops.lastLoginAt).toLocaleString());
  assert.equal(rows[1].querySelector('.status-badge')?.textContent, 'Inactive');
  assert.equal(rows[1].querySelector('.last-sign-in')?.textContent, 'Never');
  // The list carries no password: nothing on the page asks for or shows one until a modal opens.
  assert.equal(document.querySelector('input[type="password"]'), null, 'the list shows a password field');
  for (const row of rows) assert.equal(row.textContent?.toLowerCase().includes('password'), false);
});

// Users.css turns rows into cards at max-width: 768px, which has no slot for the last sign-in.
test('at 768px the table drops the last sign-in column', async () => {
  const width = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { value: 768, configurable: true, writable: true });
  try {
    renderUsers();
    await rtl.screen.findByText('ops@example.com');
    const headers = Array.from(document.querySelectorAll('thead th')).map(th => th.textContent);
    assert.deepEqual(headers, ['Email', 'Role', 'Status', 'Actions']);
  } finally {
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
  }
});

test('a refused read says so instead of showing the empty state', async () => {
  listStatus = 403;
  renderUsers();
  await rtl.screen.findByText('No access to users');
  assert.ok(!rtl.screen.queryByText('No users yet'), 'a refused read rendered as an empty list');
});

test('a failed read shows the error instead of the empty state', async () => {
  listStatus = 500;
  renderUsers();
  await rtl.screen.findByText('Could not load users');
  assert.ok(!rtl.screen.queryByText('No users yet'), 'a failed read rendered as an empty list');
});

test('with no users the empty state invites the first one', async () => {
  userList = [];
  renderUsers();
  await rtl.screen.findByText('No users yet');
});

async function openCreate(): Promise<HTMLButtonElement> {
  renderUsers();
  await rtl.screen.findByText('ops@example.com');
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Create User' }));
  return rtl.screen.getByRole<HTMLButtonElement>('button', { name: 'Create' });
}

test('a create sends the address trimmed and lower-cased with the password and role, then closes', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const create = await openCreate();
  assert.equal(create.disabled, true);
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: '  New.Admin@Example.com ' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse' } });
  fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'admin' } });
  assert.equal(create.disabled, false);
  fireEvent.click(create);
  await waitFor(() => assert.ok(createBody));
  assert.deepEqual(createBody, { email: 'new.admin@example.com', password: 'correct horse', role: 'admin' });
  await waitFor(() => assert.equal(screen.queryByRole('dialog') === null, true));
  // The role defaults to operator, the least privilege that can still do anything.
  rtl.cleanup();
  const again = await openCreate();
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ops2@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse' } });
  fireEvent.click(again);
  await waitFor(() => assert.equal(createBody?.role, 'operator'));
});

test('a password outside the bounds the gateway publishes keeps Create disabled and says why', async () => {
  const { screen, fireEvent } = rtl;
  const create = await openCreate();
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ops2@example.com' } });
  // Seven code points: an emoji counts as one, as the gateway's validator counts it.
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: '\u{1F511}'.repeat(PASSWORD_MIN_LENGTH - 1) },
  });
  assert.equal(create.disabled, true);
  screen.getByText(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: '\u{1F511}'.repeat(PASSWORD_MIN_LENGTH) } });
  assert.equal(create.disabled, false);
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'x'.repeat(PASSWORD_MAX_LENGTH + 1) } });
  assert.equal(create.disabled, true);
  screen.getByText(`Limited to ${PASSWORD_MAX_LENGTH} characters (${PASSWORD_MAX_LENGTH + 1} now).`);
});

test('an address the gateway would refuse keeps Create disabled and names the problem', async () => {
  const { screen, fireEvent } = rtl;
  const create = await openCreate();
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse' } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ops@localhost' } });
  assert.equal(create.disabled, true);
  screen.getByText('Enter a valid email address.');
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ops@example.com' } });
  assert.equal(create.disabled, false);
});

test('a refused create keeps the modal open and reports the reason', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  createStatus = 409;
  const create = await openCreate();
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ops@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse' } });
  fireEvent.click(create);
  await waitFor(() => screen.getByText("A user with email 'ops@example.com' already exists"));
  screen.getByRole('dialog');
});

async function openEdit(user: Record<string, unknown> = ops): Promise<HTMLButtonElement> {
  userList = [user];
  renderUsers();
  await rtl.screen.findByText(String(user.email));
  rtl.fireEvent.click(rtl.screen.getByTitle('Edit user'));
  return rtl.screen.getByRole<HTMLButtonElement>('button', { name: 'Save' });
}

test('the edit form starts from the stored user with a blank password and warns about sign-out', async () => {
  const { screen } = rtl;
  await openEdit();
  assert.equal(screen.getByLabelText<HTMLInputElement>('Email').value, 'ops@example.com');
  assert.equal(screen.getByLabelText<HTMLSelectElement>('Role').value, 'operator');
  assert.equal(screen.getByLabelText<HTMLInputElement>('Active').checked, true);
  assert.equal(screen.getByLabelText<HTMLInputElement>('New password (optional)').value, '');
  screen.getByText('Changing the password, role or active state signs this user out everywhere.');
});

test('saving an untouched user sends nothing', async () => {
  const save = await openEdit();
  rtl.fireEvent.click(save);
  await rtl.waitFor(() => assert.equal(rtl.screen.queryByRole('button', { name: 'Save' }) === null, true));
  assert.deepEqual(updateBodies, []);
});

test('an edit sends only what changed', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  let save = await openEdit();
  fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'admin' } });
  fireEvent.click(screen.getByLabelText('Active'));
  fireEvent.click(save);
  await waitFor(() => assert.equal(updateBodies.length, 1));
  assert.deepEqual(updateBodies[0], { role: 'admin', isActive: false });

  rtl.cleanup();
  save = await openEdit();
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: ' Ops@Example.com' } });
  fireEvent.change(screen.getByLabelText('New password (optional)'), { target: { value: 'battery staple' } });
  fireEvent.click(save);
  await waitFor(() => assert.equal(updateBodies.length, 2));
  // The address only changed case and spacing, which the gateway stores away; the password is new.
  assert.deepEqual(updateBodies[1], { password: 'battery staple' });
  await waitFor(() => assert.equal(screen.queryByRole('dialog') === null, true));
});

test('a new password shorter than the minimum keeps Save disabled; blank keeps the stored one', async () => {
  const { screen, fireEvent } = rtl;
  const save = await openEdit();
  fireEvent.change(screen.getByLabelText('New password (optional)'), { target: { value: 'short' } });
  assert.equal(save.disabled, true);
  screen.getByText(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
  fireEvent.change(screen.getByLabelText('New password (optional)'), { target: { value: '' } });
  assert.equal(save.disabled, false);
});

test('a delete asks first, names the address, and sends the DELETE on confirmation', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  renderUsers();
  await screen.findByText('ops@example.com');
  fireEvent.click(screen.getByTitle('Delete'));
  const dialog = screen.getByRole('dialog');
  assert.ok(
    dialog.querySelector('strong')?.textContent === 'ops@example.com',
    'the confirmation does not name the user',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  assert.equal(screen.queryByRole('dialog'), null);
  assert.deepEqual(deleted, []);

  fireEvent.click(screen.getByTitle('Delete'));
  // The row's icon button is also named Delete, so the confirmation is found within the dialog.
  fireEvent.click(rtl.within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
  await waitFor(() => assert.deepEqual(deleted, ['user-1']));
});

test('userPatch holds the gateway to the fields the edit changed', () => {
  const user = { ...ops, role: 'operator' as const, isActive: true };
  assert.deepEqual(userPatch(user, { email: 'ops@example.com', role: 'operator', isActive: true, password: '' }), {});
  assert.deepEqual(userPatch(user, { email: 'OPS@example.com ', role: 'viewer', isActive: false, password: 'pw' }), {
    role: 'viewer',
    isActive: false,
    password: 'pw',
  });
  assert.deepEqual(userPatch(user, { email: 'new@example.com', role: 'operator', isActive: true, password: '' }), {
    email: 'new@example.com',
  });
});

test('isValidEmail wants a local part, a domain and a top-level label, within 254 characters', () => {
  assert.equal(isValidEmail('ops@example.com'), true);
  assert.equal(isValidEmail(' Ops@Example.com '), true);
  for (const bad of ['', 'ops', 'ops@', '@example.com', 'ops@localhost', 'ops example@example.com']) {
    assert.equal(isValidEmail(bad), false, `${JSON.stringify(bad)} passed`);
  }
  // '@example.com' is 12 characters, so 242 in the local part reach the 254 the gateway stores.
  assert.equal(isValidEmail(`${'a'.repeat(242)}@example.com`), true);
  assert.equal(isValidEmail(`${'a'.repeat(243)}@example.com`), false);
});

// The sign-up plan card: an admin changes what a self-service sign-up on the site is charged.
test('the sign-up plan card shows the saved plan and saves only a changed, valid plan', async () => {
  renderUsers();
  const amount = (await rtl.screen.findByLabelText('Amount per month')) as HTMLInputElement;
  assert.equal(amount.value, '30');
  const months = rtl.screen.getByLabelText('Number of months') as HTMLInputElement;
  assert.equal(months.value, '12');
  const save = rtl.screen.getByRole('button', { name: 'Save plan' }) as HTMLButtonElement;
  assert.equal(save.disabled, true, 'an unchanged plan can be saved');

  rtl.fireEvent.change(amount, { target: { value: '45' } });
  rtl.fireEvent.change(months, { target: { value: '6' } });
  await rtl.waitFor(() => assert.equal(save.disabled, false));
  assert.ok(rtl.screen.getByText(/\$270/), 'the total does not follow the draft');

  rtl.fireEvent.change(months, { target: { value: '1' } });
  await rtl.waitFor(() => assert.equal(save.disabled, true, 'fewer than two charges can be saved'));
  rtl.fireEvent.change(months, { target: { value: '6' } });
  await rtl.waitFor(() => assert.equal(save.disabled, false));

  rtl.fireEvent.click(save);
  await rtl.waitFor(() => assert.equal(planBodies.length, 1));
  assert.deepEqual(planBodies[0], {
    description: 'Scalorus WA — 12 months',
    amount: 45,
    currencyCode: 'USD',
    paymentsNumber: 6,
    fallbackAmountIls: 95,
  });
  await rtl.screen.findByText('Sign-up plan saved. New sign-ups are charged the new price.');
});
