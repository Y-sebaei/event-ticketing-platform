const BASE = import.meta.env.VITE_API_URL ?? '/api';

export interface ApiError extends Error {
  status: number;
  code?: string;
  traceId?: string;
  details?: unknown;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    // The trace id travels with the error so the UI can show it. A support
    // conversation that starts with a trace id is a very short one.
    const error = new Error(body.message ?? response.statusText) as ApiError;
    error.status = response.status;
    error.code = body.error;
    error.traceId = body.traceId;
    error.details = body.details;
    throw error;
  }

  return body as T;
}

export interface EventDocument {
  eventId: string;
  slug: string;
  title: string;
  description: string;
  startsAt: string;
  city: string;
  venueName: string;
  minPriceCents: number;
  maxPriceCents: number;
  currency: string;
}

export interface SearchResponse {
  items: EventDocument[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  source: 'search' | 'database';
}

export interface TicketType {
  id: string;
  name: string;
  priceCents: number;
  maxPerOrder: number;
  quantityTotal: number;
  quantityAvailable: number;
  salesStartAt: string;
  salesEndAt: string;
}

export interface EventDetail {
  id: string;
  slug: string;
  title: string;
  description: string;
  startsAt: string;
  currency: string;
  serviceFeeBps: number;
  venue: { id: string; name: string; city: string; addressLine: string };
  ticketTypes: TicketType[];
}

export interface OrderView {
  id: string;
  status: 'pending' | 'paid' | 'fulfilled' | 'failed' | 'expired';
  statusDetail: string | null;
  subtotalCents: number;
  feeCents: number;
  totalCents: number;
  currency: string;
  paymentUrl: string | null;
  event: { slug: string; title: string; startsAt: string; venueName: string; city: string };
  customer: { email: string; name: string };
  items: { ticketTypeId: string; name: string; unitPriceCents: number; quantity: number }[];
  tickets: { serial: string; seq: number; issuedAt: string }[];
}

export const api = {
  search(params: Record<string, string | number | undefined>): Promise<SearchResponse> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') query.set(key, String(value));
    }
    return request<SearchResponse>(`/events?${query.toString()}`);
  },

  cities(): Promise<string[]> {
    return request<string[]>('/search/cities');
  },

  event(slug: string): Promise<EventDetail> {
    return request<EventDetail>(`/events/${slug}`);
  },

  checkout(
    body: {
      eventSlug: string;
      customer: { email: string; name: string };
      items: { ticketTypeId: string; quantity: number }[];
    },
    idempotencyKey: string,
  ) {
    return request<{
      orderId: string;
      accessToken: string;
      paymentUrl: string;
      totalCents: number;
      traceId?: string;
    }>('/checkout', {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify(body),
    });
  },

  order(id: string, token: string): Promise<OrderView> {
    return request<OrderView>(`/orders/${id}?token=${encodeURIComponent(token)}`);
  },

  completeLocalPayment(body: { sessionId: string; orderId: string; outcome: 'succeeded' | 'failed' }) {
    return request<{ delivered: boolean }>('/payments/local/complete', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
};
