<script setup lang="ts">
import { ref } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../lib/api';
import { formatMoney } from '../lib/format';

/**
 * The built-in checkout page, reached only when no Stripe key is configured.
 * It exists so a reviewer who clones this repository and runs one command can
 * complete a real purchase — signed webhook, deduplication, Kafka, fulfilment
 * and all — without creating a Stripe account.
 *
 * With Stripe configured, the API hands back a Stripe Checkout URL instead and
 * the browser never arrives here.
 */
const route = useRoute();

const sessionId = String(route.query.session ?? '');
const orderId = String(route.query.order ?? '');
const amountCents = Number(route.query.amount ?? 0);
const currency = String(route.query.currency ?? 'EUR');

const busy = ref(false);
const error = ref<string | null>(null);

async function pay(outcome: 'succeeded' | 'failed') {
  busy.value = true;
  error.value = null;
  try {
    await api.completeLocalPayment({ sessionId, orderId, outcome });
    // Straight to the confirmation page. Whether the webhook has already been
    // processed by the time we get there is deliberately not coordinated — that
    // race is the one the confirmation page is built to handle.
    const returnUrl = String(route.query.return ?? `/orders/${orderId}`);
    window.location.href = returnUrl;
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="card stack" style="max-width: 460px; margin: 40px auto">
    <span class="badge">Test payment</span>
    <h1 style="margin: 4px 0; font-size: 22px">{{ formatMoney(amountCents, currency) }}</h1>
    <p class="muted small" style="margin: 0">
      No Stripe key is configured, so this stands in for Stripe Checkout. It posts a
      signed webhook to the same endpoint Stripe would, and everything downstream runs
      unchanged.
    </p>
    <p class="mono muted" style="margin: 0">{{ sessionId }}</p>

    <p v-if="error" class="error">{{ error }}</p>

    <button :disabled="busy" data-testid="pay-success" @click="pay('succeeded')">
      {{ busy ? 'Processing…' : 'Pay with test card 4242' }}
    </button>
    <button class="ghost" :disabled="busy" data-testid="pay-decline" @click="pay('failed')">
      Simulate a declined card (4000 … 0002)
    </button>
  </div>
</template>
