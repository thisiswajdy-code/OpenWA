// Login page under the bare `node --test` runner, on the jsdom harness the other page tests use. The
// key typed at sign-in is the one the dashboard stores and compares against its API key prefixes, so it
// must be stored trimmed; a gateway that is down is not reported as an invalid key; and the form's
// alignment must follow the document direction set on <html>.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';

let sentKey: string | null = null;
let reply: () => Response = okReply;
// What GET /auth/login-options answers; null leaves it to `reply`, as a gateway that predates the route would.
let loginOptions: { password: boolean } | null = null;
// The last POST /auth/login body, so a test can see what the email form sent.
let loginBody: unknown = undefined;

function okReply(): Response {
  return new Response(JSON.stringify({ valid: true, role: 'admin' }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/auth/login-options') && loginOptions) {
      return Promise.resolve(
        new Response(JSON.stringify(loginOptions), { headers: { 'Content-Type': 'application/json' } }),
      );
    }
    if (url.endsWith('/auth/login')) loginBody = JSON.parse(String(init?.body));
    sentKey = new Headers(init?.headers).get('X-API-Key');
    return Promise.resolve(reply());
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Login: (typeof import('./Login.tsx'))['Login'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  (globalThis as Record<string, unknown>).__APP_VERSION__ = '0.0.0-test';
  (globalThis as Record<string, unknown>).__BUILD_TIME__ = '2026-01-01T00:00:00.000Z';
  installFetchStub();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ Login } = await import('./Login.tsx'));
});

afterEach(() => {
  sentKey = null;
  reply = okReply;
  loginOptions = null;
  loginBody = undefined;
  rtl.cleanup();
});

test('a key pasted with surrounding whitespace is sent and stored trimmed', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const logins: string[] = [];
  rtl.render(createElement(Login, { onLogin: (key: string) => logins.push(key) }));

  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: '  owa_k1_secret ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

  await waitFor(() => assert.equal(logins.length, 1));
  assert.deepEqual(logins, ['owa_k1_secret']);
  assert.equal(sentKey, 'owa_k1_secret');
});

async function submitAndReadError(): Promise<string> {
  const { screen, fireEvent } = rtl;
  rtl.render(createElement(Login, { onLogin: () => assert.fail('a refused key signed in') }));
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'owa_k1_secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  const message = await rtl.waitFor(() => {
    const el = document.querySelector('.error-message');
    assert.ok(el);
    return el.textContent ?? '';
  });
  return message;
}

test('a proxy error page while the gateway is down is a connection error, not an invalid key', async () => {
  reply = () => new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } });
  assert.equal(await submitAndReadError(), 'Unable to connect to server. Please try again.');
});

test('a 5xx with a JSON message is still a connection error', async () => {
  reply = () => new Response(JSON.stringify({ statusCode: 503, message: 'Service Unavailable' }), { status: 503 });
  assert.equal(await submitAndReadError(), 'Unable to connect to server. Please try again.');
});

test('a refused key keeps the reason the gateway gave', async () => {
  reply = () => new Response(JSON.stringify({ statusCode: 401, message: 'API key has expired' }), { status: 401 });
  assert.equal(await submitAndReadError(), 'API key has expired');
});

test('a 401 without a message reads as an invalid key', async () => {
  reply = () => new Response('', { status: 401 });
  assert.equal(await submitAndReadError(), 'Invalid API key');
});

test('a refusal other than 401 without a message is a connection error, not an invalid key', async () => {
  reply = () => new Response('', { status: 403 });
  assert.equal(await submitAndReadError(), 'Unable to connect to server. Please try again.');
});

test('the login form aligns to the document direction, which is set on <html>', () => {
  const css = readFileSync(fileURLToPath(new URL('./Login.css', import.meta.url)), 'utf8');
  // i18n sets `dir` on the document element only, so a `[dir]` compound after another selector part
  // would need a second element carrying `dir` inside the page and never matches.
  assert.deepEqual(css.match(/[^\s,{}][^,{}]*\s\[dir[^\]]*\][^{]*/g) ?? [], []);
  assert.match(css, /\.login-container \.login-form \{\s*text-align: start;\s*\}/);
});

// ---------------------------------------------------------------------------------------------------
// Email and password sign-in. The form is the default only once the gateway says a user exists; it
// exchanges the password for a login key and hands that key up exactly like a pasted one.
// ---------------------------------------------------------------------------------------------------

function loginReply(): Response {
  return new Response(
    JSON.stringify({ apiKey: 'owa_k1_login', role: 'operator', engineType: 'baileys', scoped: false }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}

test('without a dashboard user the key form shows and offers no switch', async () => {
  loginOptions = { password: false };
  const { screen } = rtl;
  rtl.render(createElement(Login, { onLogin: () => assert.fail('nothing was submitted') }));
  await screen.findByLabelText('API Key');
  // The options answer has landed by now (same microtask queue); the form stays on the key.
  await rtl.waitFor(() => assert.equal(screen.queryByText('Sign in with email and password instead'), null));
  assert.equal(screen.queryByLabelText('Email'), null);
});

test('with a dashboard user the email form is the default and signs in with the login key it receives', async () => {
  loginOptions = { password: true };
  reply = loginReply;
  const { screen, fireEvent, waitFor } = rtl;
  const logins: unknown[][] = [];
  rtl.render(createElement(Login, { onLogin: (...args: unknown[]) => logins.push(args) }));

  fireEvent.change(await screen.findByLabelText('Email'), { target: { value: ' Admin@Example.com ' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse battery staple' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

  await waitFor(() => assert.equal(logins.length, 1));
  assert.deepEqual(loginBody, { email: 'Admin@Example.com', password: 'correct horse battery staple' });
  assert.equal(sentKey, null, 'the password form sends no API key header');
  assert.deepEqual(logins, [['owa_k1_login', 'operator', 'baileys', false, 'password', false]]);
});

test('a refused password shows the dashboard wording, not the gateway message, and a 429 names the throttle', async () => {
  loginOptions = { password: true };
  const { screen, fireEvent } = rtl;
  rtl.render(createElement(Login, { onLogin: () => assert.fail('a refused sign-in signed in') }));
  fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'admin@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });

  reply = () =>
    new Response(JSON.stringify({ statusCode: 401, message: 'Invalid email or password' }), { status: 401 });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await rtl.waitFor(() =>
    assert.equal(document.querySelector('.error-message')?.textContent, 'Invalid email or password'),
  );

  reply = () => new Response(JSON.stringify({ statusCode: 429, message: 'ThrottlerException' }), { status: 429 });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await rtl.waitFor(() =>
    assert.equal(
      document.querySelector('.error-message')?.textContent,
      'Too many sign-in attempts. Please wait a minute and try again.',
    ),
  );
});

test('the switch moves between the two forms and clears the error', async () => {
  loginOptions = { password: true };
  const { screen, fireEvent } = rtl;
  const logins: unknown[][] = [];
  rtl.render(createElement(Login, { onLogin: (...args: unknown[]) => logins.push(args) }));
  await screen.findByLabelText('Email');

  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  assert.equal(document.querySelector('.error-message')?.textContent, 'Email is required');

  fireEvent.click(screen.getByRole('button', { name: 'Sign in with an API key instead' }));
  assert.equal(document.querySelector('.error-message'), null);
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'owa_k1_secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  await rtl.waitFor(() => assert.equal(logins.length, 1));
  assert.deepEqual(logins, [['owa_k1_secret', 'admin', undefined, false, 'apiKey', false]]);

  rtl.cleanup();
  rtl.render(createElement(Login, { onLogin: () => undefined }));
  await screen.findByLabelText('Email');
  fireEvent.click(screen.getByRole('button', { name: 'Sign in with an API key instead' }));
  fireEvent.click(screen.getByRole('button', { name: 'Sign in with email and password instead' }));
  assert.ok(screen.getByLabelText('Password'));
});
