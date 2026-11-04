import { Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { constantTimeEqual } from '../../common/security/constantTimeEqual';

/**
 * The recurring-payments API that bills a Scalorus WA account (`ARVY_API_URL`, authenticated with
 * the admin token in `ARVY_API_TOKEN`). A link is created per sign-up under this gateway's source
 * (`ARVY_SOURCE_ID`); billing starts once the customer saves a card on its `payment_link` page, at
 * which point the API POSTs a signed notification to the source's notify URL (`/notify` here,
 * verified with `ARVY_SOURCE_SECRET`), and `GET` reports where the payment stands.
 */
export const ARVY_DEFAULT_API_URL = 'https://arvy.store/api/v1';
/** The source Arvy notifies for this gateway, unless `ARVY_SOURCE_ID` says otherwise. */
export const ARVY_DEFAULT_SOURCE_ID = 1;
/** The event a recurring link sends once: the customer saved a card and billing is active. */
export const ARVY_ACTIVE_EVENT = 'recurring_payment.active';
/** The event a one-time link sends when paid. This gateway creates none, but the source may carry some. */
export const ARVY_PAID_EVENT = 'payment_link.paid';
const TIMEOUT_MS = 15_000;

export type ArvyLinkStatus = 'pending_card' | 'active' | 'completed' | 'cancelled';
export type ArvyChargeFrequency = 'weekly' | 'monthly' | 'quarterly' | 'half-yearly' | 'yearly';
export type ArvyLocale = 'he' | 'ar' | 'en';
/** The card-page language as the API names it (`lang` wins over `locale` when both are sent). */
export type ArvyLang = 'il' | 'us' | 'ar';
export const ARVY_LANG_FOR_LOCALE: Record<ArvyLocale, ArvyLang> = { he: 'il', en: 'us', ar: 'ar' };

export interface ArvyCreateLinkRequest {
  /** Charge per period, min 0.01. */
  amount: number;
  charge_frequency: ArvyChargeFrequency;
  /** Max 255 characters. */
  description: string;
  /** `YYYY-MM-DD`, today or later. */
  first_charge_date: string;
  /** Number of charges, 2 to 9999. */
  sto_payments_number: number;
  /** Source to notify when the payment is active. */
  source_id?: number;
  /** Our own id (max 255), sent back in the notification. */
  reference?: string;
  customer_name?: string;
  customer_email?: string;
  customer_phone?: string;
  /** Three letters; the API defaults to ILS. */
  currency_code?: string;
  vat_percent?: number;
  /** Language of the card page: `il` Hebrew (default), `us` English, `ar` Arabic. */
  lang?: ArvyLang;
  /** Older spelling of the same choice; `lang` wins when both are sent. */
  locale?: ArvyLocale;
}

export interface ArvyLink {
  id: number;
  status: ArvyLinkStatus;
  payment_link: string;
  amount: number;
  currency_code: string;
  lang?: ArvyLang;
  locale?: ArvyLocale;
  description: string;
  charge_frequency: ArvyChargeFrequency;
  sto_payments_number: number;
  first_charge_date: string;
  source_id: number | null;
  reference: string | null;
  /** Set once the source was notified successfully. */
  source_notified_at: string | null;
  charges_completed: number;
}

/** A recurring payment as a notification describes it. */
export interface ArvyNotifiedRecurringPayment {
  id: number;
  status: ArvyLinkStatus;
  reference: string | null;
  amount: number;
  currency_code: string;
  description: string;
  charge_frequency: ArvyChargeFrequency;
  sto_payments_number: number;
  first_charge_date: string;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  card_last4?: string | null;
  tranzila_sto_id?: string | null;
}

/** A one-time payment link as a `payment_link.paid` notification describes it. */
export interface ArvyNotifiedPaymentLink {
  id: number;
  status: 'pending' | 'paid' | 'cancelled';
  reference: string | null;
  amount: number;
  paid_amount: number | null;
  currency_code: string;
  description: string;
  paid_at: string | null;
  card_last4?: string | null;
  tranzila_index?: string | null;
}

/**
 * The body Arvy POSTs to the source's notify URL: `recurring_payment.active` carries
 * `recurring_payment`, `payment_link.paid` carries `payment_link`. One source can send both.
 */
export interface ArvyNotification {
  event: string;
  sent_at?: string;
  source?: { id: number; name: string };
  recurring_payment?: ArvyNotifiedRecurringPayment;
  payment_link?: ArvyNotifiedPaymentLink;
}

/**
 * Whether `X-Arvy-Signature` (`sha256=<hex HMAC-SHA256 of the raw body, keyed with the source
 * secret>`) signs `rawBody`. Compared in constant time, so neither the value nor its length leaks.
 */
export function verifyArvySignature(rawBody: string | Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return constantTimeEqual(header.trim(), expected);
}

/** Whether `value` is a payment object with a numeric id and a string status. */
function isNotifiedPayment(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const { id, status } = value as { id?: unknown; status?: unknown };
  return typeof id === 'number' && typeof status === 'string';
}

/**
 * Shape-check a parsed notification body; the signature already proves it came from Arvy. A body
 * is a notification when it names an event and carries a recurring payment or a one-time link.
 */
export function parseArvyNotification(raw: string): ArvyNotification | null {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const { event, recurring_payment, payment_link } = body as {
    event?: unknown;
    recurring_payment?: unknown;
    payment_link?: unknown;
  };
  if (typeof event !== 'string') return null;
  if (!isNotifiedPayment(recurring_payment) && !isNotifiedPayment(payment_link)) return null;
  return body as ArvyNotification;
}

/** A non-2xx answer, with the parsed body (`errors` on a 422). */
export class ArvyApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`Payment API answered ${status}`);
    this.name = 'ArvyApiError';
  }
}

export interface ArvyConfig {
  token?: string;
  baseUrl: string;
  /** The source every link is created under, so Arvy notifies this gateway. */
  sourceId: number;
  /** The source's secret, which signs the notifications; unset refuses every notification. */
  sourceSecret?: string;
}

/**
 * `ARVY_API_TOKEN` enables sign-up; `ARVY_API_URL` overrides the API base (default arvy.store);
 * `ARVY_SOURCE_ID` names the source (default 1); `ARVY_SOURCE_SECRET` verifies its notifications.
 */
export function resolveArvyConfig(env: NodeJS.ProcessEnv = process.env): ArvyConfig {
  const token = env.ARVY_API_TOKEN?.trim();
  const baseUrl = (env.ARVY_API_URL?.trim() || ARVY_DEFAULT_API_URL).replace(/\/+$/, '');
  const sourceId = Number(env.ARVY_SOURCE_ID?.trim());
  const sourceSecret = env.ARVY_SOURCE_SECRET?.trim();
  return {
    token: token || undefined,
    baseUrl,
    sourceId: Number.isInteger(sourceId) && sourceId > 0 ? sourceId : ARVY_DEFAULT_SOURCE_ID,
    sourceSecret: sourceSecret || undefined,
  };
}

/** Origin of the payment pages the API links to, for the sign-up page's `frame-src`. */
export function arvyOrigin(config: ArvyConfig = resolveArvyConfig()): string {
  return new URL(config.baseUrl).origin;
}

@Injectable()
export class ArvyClient {
  // Read from the environment; Nest constructs this with no arguments. Tests use `withConfig`.
  private config: ArvyConfig = resolveArvyConfig();

  static withConfig(config: ArvyConfig): ArvyClient {
    const client = new ArvyClient();
    client.config = config;
    return client;
  }

  /** Sign-up is offered only when a token is configured. */
  get enabled(): boolean {
    return this.config.token !== undefined;
  }

  get sourceId(): number {
    return this.config.sourceId;
  }

  /** Whether a notification carries a valid signature from this gateway's source. */
  verifyNotification(rawBody: string | Buffer, signatureHeader: string | undefined): boolean {
    return (
      this.config.sourceSecret !== undefined && verifyArvySignature(rawBody, signatureHeader, this.config.sourceSecret)
    );
  }

  /** Notifications can be verified only once the source secret is configured. */
  get notificationsEnabled(): boolean {
    return this.config.sourceSecret !== undefined;
  }

  createLink(body: ArvyCreateLinkRequest): Promise<ArvyLink> {
    return this.request<ArvyLink>('POST', '/recurring-payment-links', body);
  }

  getLink(id: string): Promise<ArvyLink> {
    return this.request<ArvyLink>('GET', `/recurring-payment-links/${encodeURIComponent(id)}`);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    if (!this.config.token) throw new Error('ARVY_API_TOKEN is not set');
    const response = await fetch(`${this.config.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!response.ok) throw new ArvyApiError(response.status, parsed);
    return parsed as T;
  }
}
