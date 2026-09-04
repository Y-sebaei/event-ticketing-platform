<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api, type OrderView as Order } from '../lib/api';
import { formatDate, formatMoney } from '../lib/format';
import { subscribeToOrder } from '../lib/socket';

const route = useRoute();
const order = ref<Order | null>(null);
const error = ref<string | null>(null);

const orderId = String(route.params.id);
const token = String(route.query.token ?? '');

let unsubscribe: (() => void) | undefined;
let poll: ReturnType<typeof setInterval> | undefined;

async function refresh() {
  try {
    order.value = await api.order(orderId, token);
    if (order.value.status === 'fulfilled' || order.value.status === 'failed') {
      clearInterval(poll);
    }
  } catch (err) {
    error.value = (err as Error).message;
    clearInterval(poll);
  }
}

onMounted(async () => {
  await refresh();

  /*
   * This page is the answer to "what if the webhook arrives before the browser
   * redirect".
   *
   * Nothing here triggers fulfilment; the webhook does that, on its own
   * schedule. So one of two things is true when this page loads: the order is
   * already fulfilled and it renders tickets immediately, or it is still
   * pending and the update arrives over the WebSocket a moment later. Neither
   * is treated as the exceptional case.
   *
   * The poll is a safety net for a dropped socket, not the primary mechanism,
   * which is why it stops as soon as the order reaches a terminal state.
   */
  unsubscribe = subscribeToOrder(orderId, () => void refresh());
  poll = setInterval(refresh, 2_000);
});

onUnmounted(() => {
  unsubscribe?.();
  clearInterval(poll);
});
</script>

<template>
  <p v-if="error" class="error">{{ error }}</p>

  <div v-else-if="!order" class="muted">Loading your order…</div>

  <div v-else class="stack" style="gap: 20px; max-width: 620px">
    <div>
      <span
        class="badge"
        :class="{ ok: order.status === 'fulfilled', warn: order.status === 'pending' }"
        data-testid="order-status"
        >{{ order.status }}</span
      >
      <h1 style="margin: 12px 0 4px">{{ order.event.title }}</h1>
      <p class="muted" style="margin: 0">
        {{ order.event.venueName }}, {{ order.event.city }} · {{ formatDate(order.event.startsAt) }}
      </p>
    </div>

    <div v-if="order.status === 'pending'" class="card">
      <strong>Waiting for payment confirmation…</strong>
      <p class="muted small" style="margin: 6px 0 0">
        Your tickets appear here the moment the payment webhook is processed. You do not
        need to refresh.
      </p>
      <p v-if="order.paymentUrl" style="margin-top: 12px">
        <a :href="order.paymentUrl" class="badge">Return to payment</a>
      </p>
    </div>

    <div v-else-if="order.status === 'failed' || order.status === 'expired'" class="card">
      <strong>This order did not complete.</strong>
      <p class="muted small" style="margin: 6px 0 0">
        {{ order.statusDetail ?? 'The payment was not successful.' }} Your seats have been
        released back to the pool.
      </p>
      <RouterLink :to="`/events/${order.event.slug}`" class="badge" style="margin-top: 12px; display: inline-block">
        Try again
      </RouterLink>
    </div>

    <div class="card stack">
      <h2 style="margin: 0; font-size: 17px">Order</h2>
      <div v-for="item in order.items" :key="item.ticketTypeId" class="row small">
        <span>{{ item.quantity }} × {{ item.name }}</span>
        <span>{{ formatMoney(item.unitPriceCents * item.quantity, order.currency) }}</span>
      </div>
      <div class="row small"><span class="muted">Service fee</span><span>{{ formatMoney(order.feeCents, order.currency) }}</span></div>
      <div class="row" style="border-top: 1px solid var(--border); padding-top: 10px">
        <strong>Total</strong><strong>{{ formatMoney(order.totalCents, order.currency) }}</strong>
      </div>
    </div>

    <div v-if="order.tickets.length" class="card stack" data-testid="tickets">
      <h2 style="margin: 0; font-size: 17px">
        {{ order.tickets.length }} ticket<span v-if="order.tickets.length !== 1">s</span>
      </h2>
      <div v-for="ticket in order.tickets" :key="ticket.serial" class="row">
        <span class="mono" data-testid="ticket-serial">{{ ticket.serial }}</span>
        <span class="muted small">seat {{ ticket.seq }}</span>
      </div>
      <p class="muted small" style="margin: 0">
        A confirmation email was sent to {{ order.customer.email }}. In local development
        it lands in Mailpit at <span class="mono">localhost:8025</span>.
      </p>
    </div>
  </div>
</template>
