import { Module, INestApplication, Controller, Get } from '@nestjs/common';
import { applyGlobalValidation } from '../src/config/app-validation';
import { configureApp } from '../src/configure-app';
import { DASHBOARD_BASE_PATH } from '../src/app.module';
import { NestFactory } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import request from 'supertest';
import { App } from 'supertest/types';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, sep } from 'path';

/**
 * Two throwaway dashboard builds, evaluated before the module decorators (forRoot reads rootPath
 * eagerly). The second deliberately sits under a DOT-SEGMENT directory, which is not exotic:
 * `~/.openwa`, a CI checkout under `~/.cache`, and a `TMPDIR` inside a dotdir all produce it.
 * `ServeStaticModule`'s own SPA fallback silently 404s every client-side route on such a path
 * (it sends the index by absolute path, and Express's `send` refuses dot-segments), so the shape
 * has to be covered explicitly or a real deployment class goes untested.
 */
function makeBuild(root: string): string {
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>Scalorus WA Dashboard</title>');
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(root, '.env.secret'), 'TOKEN=nope');
  return root;
}

/** A throwaway static site next to each build: the homepage at `/`, served by the same process. */
function makeSite(root: string): string {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>Scalorus WA Site</title>');
  writeFileSync(join(root, 'signup.html'), '<!doctype html><title>Scalorus WA Sign-up</title>');
  writeFileSync(join(root, 'styles.css'), 'body{}');
  return root;
}

const hasDotSegment = (p: string): boolean => p.split(sep).some(segment => segment.startsWith('.'));

const osTmp = realpathSync(tmpdir());
// The "plain" build must sit under a genuinely dot-free prefix. os.tmpdir() is NOT reliably
// dot-free, and using it blindly would make BOTH cases dotted - which is exactly how this gap
// stayed hidden. node_modules is gitignored, so nothing strays into the working tree.
const dotFreeBase = hasDotSegment(osTmp) ? join(__dirname, '..', 'node_modules') : osTmp;
const plainRoot = mkdtempSync(join(dotFreeBase, 'openwa-dash-plain-'));
const dottedRoot = mkdtempSync(join(osTmp, 'openwa-dash-'));
const plainDist = makeBuild(join(plainRoot, 'dashboard', 'dist'));
const dottedDist = makeBuild(join(dottedRoot, '.dotted', 'dashboard', 'dist'));
const plainSite = makeSite(join(plainRoot, 'site'));
const dottedSite = makeSite(join(dottedRoot, '.dotted', 'site'));
// The e2e globalTeardown sweeps only openwa-e2e-* entries in the temp dir, and the plain root can sit
// under node_modules, so this suite removes its own fixtures.
afterAll(() => {
  for (const root of [plainRoot, dottedRoot]) rmSync(root, { recursive: true, force: true });
});

@Controller()
class PingController {
  @Get('ping')
  ping() {
    return { ok: true };
  }
}

const EXCLUDE = ['/api/{*splat}', '/socket.io/{*splat}'];
// Mirrors app.module.ts: the module's own catch-all fallback is off, main.ts's document
// handler owns SPA routes. Without this the module answers every unmatched GET with the
// shell, which is the behaviour the missing-asset test below exists to prevent.
const RENDER_DISABLED = '/__openwa_spa_fallback_owned_by_main_ts__';
const SITE_RENDER_DISABLED = '/__openwa_site_fallback_disabled__';

const staticModules = (dist: string, site: string) => [
  ServeStaticModule.forRoot({
    rootPath: dist,
    serveRoot: DASHBOARD_BASE_PATH,
    exclude: EXCLUDE,
    renderPath: RENDER_DISABLED,
  }),
  ServeStaticModule.forRoot({
    rootPath: site,
    exclude: [...EXCLUDE, `${DASHBOARD_BASE_PATH}/{*splat}`],
    serveStaticOptions: { index: 'index.html' },
    renderPath: SITE_RENDER_DISABLED,
  }),
];

@Module({ imports: staticModules(plainDist, plainSite), controllers: [PingController] })
class PlainServeStaticModule {}

@Module({ imports: staticModules(dottedDist, dottedSite), controllers: [PingController] })
class DottedServeStaticModule {}

describe('serve-static test fixtures', () => {
  it('really does cover BOTH install-path shapes', () => {
    // Without this, a dotted os.tmpdir() collapses the matrix onto one shape and the
    // dot-segment case silently stops being tested.
    expect(hasDotSegment(plainDist)).toBe(false);
    expect(hasDotSegment(dottedDist)).toBe(true);
  });
});

/**
 * Regression lock for single-port dashboard serving (app.module.ts + main.ts). Bootstraps the SAME
 * serve-static config (rootPath + exclude) AND the same document handler against a throwaway build:
 * the SPA must be served at `/` with client-side fallback, while Nest keeps ownership of `/api` so
 * unknown API routes return JSON 404s (not the SPA index.html). Pins the Express 5 /
 * path-to-regexp v8 wildcard syntax (`/api/{*splat}`) - if a dep bump breaks it, /api/* would start
 * returning index.html and these tests fail.
 */
describe.each([
  ['a plain install path', PlainServeStaticModule, plainDist, plainSite],
  ['an install path with a dot-segment', DottedServeStaticModule, dottedDist, dottedSite],
])('Dashboard serve-static (e2e) - %s', (_label, moduleClass, distDir, siteDir) => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    // The REAL production stack, pointed at this fixture build. It used to be a copy of the
    // document handler kept in this file, minus the nonce injection, so a divergence between the
    // copy and the original passed.
    app = await NestFactory.create(moduleClass, { bodyParser: false, logger: false });
    configureApp(app, { dashboard: { distDir, enabled: true }, site: { dir: siteDir, enabled: true } });
    applyGlobalValidation(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('serves the site homepage at /, with a CSP that admits Google Fonts and the payment iframe', async () => {
    const res = await request(app.getHttpServer()).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('Scalorus WA Site');
    expect(res.text).not.toContain('Scalorus WA Dashboard');
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain('https://fonts.googleapis.com');
    expect(csp).toContain('https://fonts.gstatic.com');
    expect(csp).toMatch(/frame-src 'self' https:\/\/[a-z.]+/);
  });

  it('serves the site files by name, without the dashboard policy', async () => {
    const page = await request(app.getHttpServer()).get('/signup.html');
    expect(page.status).toBe(200);
    expect(page.text).toContain('Scalorus WA Sign-up');
    const css = await request(app.getHttpServer()).get('/styles.css');
    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toMatch(/css/);
  });

  it('serves the dashboard index.html at /app, under the dashboard policy', async () => {
    const res = await request(app.getHttpServer()).get('/app');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('Scalorus WA Dashboard');
    const csp = res.headers['content-security-policy'];
    expect(csp).not.toContain('fonts.googleapis.com');
    expect(csp).toContain("script-src 'self' 'nonce-");
  });

  it('serves index.html for client-side routes (SPA fallback)', async () => {
    const res = await request(app.getHttpServer()).get('/app/sessions');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('Scalorus WA Dashboard');
  });

  it('serves index.html for a nested client-side route', async () => {
    const res = await request(app.getHttpServer()).get('/app/sessions/abc/messages');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
  });

  it('does not hand the SPA shell to an unknown path outside /app', async () => {
    const res = await request(app.getHttpServer()).get('/sessions').set('Accept', 'text/html');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('Scalorus WA Dashboard');
  });

  it('never answers an /assets path with the SPA shell, even extensionless', async () => {
    // The handler excludes /assets/ explicitly. Every other case is already covered by the
    // extension check, so deleting the exclusion breaks nothing visible: an extensionless asset
    // path asking for HTML is the one request that tells the two apart, and without it the guard
    // is unprotected.
    const res = await request(app.getHttpServer()).get('/app/assets/app').set('Accept', 'text/html');
    expect(res.status).toBe(404);
  });

  it('serves built assets with their own content-type (not the SPA shell)', async () => {
    const res = await request(app.getHttpServer()).get('/app/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.text).not.toContain('Scalorus WA Dashboard');
  });

  it('404s a missing asset instead of handing back the SPA shell', async () => {
    // A mistyped <script src> must fail loudly. Answering 200 HTML makes the browser try to
    // parse the shell as JavaScript and report a syntax error, hiding the real cause.
    const res = await request(app.getHttpServer()).get('/app/assets/missing.js');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('Scalorus WA Dashboard');
  });

  it('404s a missing top-level file rather than serving the shell', async () => {
    const res = await request(app.getHttpServer()).get('/app/favicon-missing.svg');
    expect(res.status).toBe(404);
  });

  it('never serves a dotfile out of the build directory', async () => {
    const res = await request(app.getHttpServer()).get('/app/.env.secret');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('TOKEN=');
  });

  it('lets Nest handle /api routes (real controller, not the SPA)', async () => {
    const res = await request(app.getHttpServer()).get('/api/ping');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('lets Nest handle a mis-cased /api route, as routing matches it case-insensitively', async () => {
    const res = await request(app.getHttpServer()).get('/API/ping');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('returns a JSON 404 (not the SPA) for unknown /api routes', async () => {
    const res = await request(app.getHttpServer()).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.text).not.toContain('Scalorus WA Dashboard');
  });

  it('does not hand the SPA to a non-GET request', async () => {
    // A mistyped POST must fail loudly rather than receiving a 200 HTML shell.
    const res = await request(app.getHttpServer()).post('/app/sessions');
    expect(res.status).not.toBe(200);
  });
});
