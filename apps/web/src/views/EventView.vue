<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api, type EventDetail } from '../lib/api';
import { formatDate, formatMoney, idempotencyKeyFor } from '../lib/format';
import { subscribeToEvent } from '../lib/socket';

const route = useRoute();

const event = ref<EventDetail | null>(null);
const quantities = ref<Record<string, number>>({});
const recentlyChanged = ref<Set<string>>(new Set());
const email = ref('');
const name = ref('');
const error = ref<string | null>(null);
const traceId = ref<string | null>(null);
const submitting = ref(false);

let unsubscribe: (() => void) | undefined;

const subtotalCents = computed(() =>
  (event.value?.ticketTypes ?? []).reduce(
    (sum, t) => sum + t.priceCents * (quantities.value[t.id] ?? 0),
    0,
  ),
);
const feeCents = computed(() =>
  subtotalCents.value > 0
    ? Math.round((subtotalCents.value * (event.value?.serviceFeeBps ?? 0)) / 10_000)
    : 0,
);
const totalCents = computed(() => subtotalCents.value + feeCents.value);
const selectedItems = computed(() =>
  Object.entries(quantities.value)
    .filter(([, quantity]) => quantity > 0)
    .map(([ticketTypeId, quantity]) => ({ ticketTypeId, quantity })),
);

onMounted(async () => {
  event.value = await api.event(String(route.params.slug));
  for (const ticketType of event.value.ticketTypes) quantities.value[ticketType.id] = 0;

  // Live inventory. Open this page in two browsers and hold tickets in one:
  // both counters move at the same moment, because both are watching the same
  // Kafka message fan out through the API's WebSocket rooms.
  unsubscribe = subscribeToEvent(event.value.id, (change) => {
    if (!event.value) return;
    for (const item of change.items) {
      const ticketType = event.value.ticketTypes.find((t) => t.id === item.ticketTypeId);
      if (!ticketType || ticketType.quantityAvailable === item.quantityAvailable) continue;
      ticketType.quantityAvailable = item.quantityAvailable;
      recentlyChanged.value = new Set(recentlyChanged.value).add(item.ticketTypeId);
      setTimeout(() => {
        const next = new Set(recentlyChanged.value);
        next.delete(item.ticketTypeId);
        recentlyChanged.value = next;
      }, 800);
    }
  });
});

onUnmounted(() => unsubscribe?.());

async function checkout() {
  if (!event.value || selectedItems.value.length === 0) return;
  submitting.value = true;
  error.value = null;
  traceId.value = null;

  try {
    // The key is derived from what is being bought, so a double-click or a
    // retried request lands on the same order rather than creating a second.
    const key = idempotencyKeyFor([
      email.value.toLowerCase(),
      event.value.id,
      ...selectedItems.value.map((i) => `${i.ticketTypeId}x${i.quantity}`),
    ]);

    const result = await api.checkout(
      {
        eventSlug: event.value.slug,
        customer: { email: email.value, name: name.value },
        items: selectedItems.value,
      },
      key,
    );

    window.location.href = result.paymentUrl;
  } catch (err) {
    const apiError = err as { message: string; traceId?: string };
    error.value = apiError.message;
    traceId.value = apiError.traceId ?? null;
    // Availability may have moved; re-read rather than leave a stale number on
    // screen next to an error saying it is stale.
    if (event.value) event.value = await api.event(event.value.slug);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div v-if="!event" class="muted">Loading…</div>

  <div v-else class="stack" style="gap: 24px">
    <div>
      <RouterLink to="/" class="muted small">← All events</RouterLink>
      <h1 style="margin: 12px 0 6px">{{ event.title }}</h1>
      <p class="muted" style="margin: 0">
        {{ event.venue.name }}, {{ event.venue.city }} · {{ formatDate(event.startsAt) }}
      </p>
      <p style="margin-top: 16px; max-width: 62ch">{{ event.description }}</p>
    </div>

    <div class="card stack">
      <h2 style="margin: 0 0 4px; font-size: 18px">Tickets</h2>

      <div
        v-for="ticketType in event.ticketTypes"
        :key="ticketType.id"
        class="row"
        style="border-top: 1px solid var(--border); padding-top: 12px"
        data-testid="ticket-type"
      >
        <div>
          <strong>{{ ticketType.name }}</strong>
          <div class="muted small">
            {{ formatMoney(ticketType.priceCents, event.currency) }} · max
            {{ ticketType.maxPerOrder }} per order
          </div>
          <div class="small" :data-testid="`remaining-${ticketType.id}`">
            <span
              class="remaining"
              :class="{ changed: recentlyChanged.has(ticketType.id) }"
              >{{ ticketType.quantityAvailable }}</span
            >
            <span class="muted"> of {{ ticketType.quantityTotal }} left</span>
          </div>
        </div>
        <select
          v-model.number="quantities[ticketType.id]"
          :disabled="ticketType.quantityAvailable === 0"
          :aria-label="`Quantity for ${ticketType.name}`"
          :data-testid="`quantity-${ticketType.id}`"
        >
          <option
            v-for="n in Math.min(ticketType.maxPerOrder, ticketType.quantityAvailable) + 1"
            :key="n - 1"
            :value="n - 1"
          >
            {{ n - 1 }}
          </option>
        </select>
      </div>

      <div v-if="totalCents > 0" class="stack" style="border-top: 1px solid var(--border); padding-top: 12px">
        <div class="row small"><span class="muted">Subtotal</span><span>{{ formatMoney(subtotalCents, event.currency) }}</span></div>
        <div class="row small"><span class="muted">Service fee</span><span>{{ formatMoney(feeCents, event.currency) }}</span></div>
        <div class="row"><strong>Total</strong><strong data-testid="total">{{ formatMoney(totalCents, event.currency) }}</strong></div>
      </div>
    </div>

    <div class="card stack">
      <h2 style="margin: 0; font-size: 18px">Your details</h2>
      <input v-model="name" placeholder="Full name" autocomplete="name" data-testid="name" />
      <input v-model="email" type="email" placeholder="Email" autocomplete="email" data-testid="email" />

      <p v-if="error" class="error">
        {{ error }}
        <span v-if="traceId" class="mono muted" style="display: block; margin-top: 6px">
          trace {{ traceId }}
        </span>
      </p>

      <button
        :disabled="submitting || selectedItems.length === 0 || !email || !name"
        data-testid="checkout"
        @click="checkout"
      >
        {{ submitting ? 'Reserving…' : `Buy for ${formatMoney(totalCents, event.currency)}` }}
      </button>
      <p class="muted small" style="margin: 0">
        Seats are held for 15 minutes while you pay.
      </p>
    </div>
  </div>
</template>
