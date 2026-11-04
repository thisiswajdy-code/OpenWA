import { Injectable } from '@nestjs/common';

/**
 * The recurring-payment-links API that bills a Scalorus WA account (`ARVY_API_URL`, authenticated
 * with the admin token in `ARVY_API_TOKEN`). A link is created per sign-up; billing starts once the
 * customer saves a card on its `payment_link` page, and `GET` reports where that stands.
 */
export const ARVY_DEFAULT_API_URL = 'https://arvy.store/api/v1';
const TIMEOUT_MS = 15_000;

export type ArvyLinkStatus = 'pending_card' | 'active' | 'completed' | 'cancelled';
export type ArvyChargeFrequency = 'weekly' | 'monthly' | 'quarterly' | 'half-yearly' | 'yearly';
export type ArvyLocale = 'he' | 'ar' | 'en';

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
  customer_name?: string;
  customer_email?: string;
  customer_phone?: string;
  /** Three letters; the API defaults to ILS. */
  currency_code?: string;
  vat_percent?: number;
  /** Language of the card page. */
  locale?: ArvyLocale;
}

export interface ArvyLink {
  id: number;
  status: ArvyLinkStatus;
  payment_link: string;
  amount: number;
  currency_code: string;
  description: string;
  charge_frequency: ArvyChargeFrequency;
  sto_payments_number: number;
  first_charge_date: string;
  charges_completed: number;
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
}

/** `ARVY_API_TOKEN` enables sign-up; `ARVY_API_URL` overrides the API base (default arvy.store). */
export function resolveArvyConfig(env: NodeJS.ProcessEnv = process.env): ArvyConfig {
  const token = env.ARVY_API_TOKEN?.trim();
  const baseUrl = (env.ARVY_API_URL?.trim() || ARVY_DEFAULT_API_URL).replace(/\/+$/, '');
  return { token: token || undefined, baseUrl };
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
