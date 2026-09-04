#!/usr/bin/env node
/**
 * Seeds real Berlin venues and plausible events so the app is never empty on
 * first run. It goes through the public API rather than straight into Postgres
 * on purpose: that exercises the whole creation path — catalog write, gRPC
 * inventory registration, outbox row, Kafka, Elasticsearch indexing — so a
 * seeded database proves the pipeline works rather than bypassing it.
 *
 * Idempotent: event slugs are unique, so re-running changes nothing.
 */
const API = process.env.API_URL ?? 'http://localhost:3000';

const VENUES = {
  berghain: {
    slug: 'berghain',
    name: 'Berghain',
    addressLine: 'Am Wriezener Bahnhof, 10243 Berlin',
    city: 'Berlin',
    country: 'DE',
    latitude: 52.5111,
    longitude: 13.4432,
    capacity: 1500,
  },
  astra: {
    slug: 'astra-kulturhaus',
    name: 'Astra Kulturhaus',
    addressLine: 'Revaler Str. 99, 10245 Berlin',
    city: 'Berlin',
    country: 'DE',
    latitude: 52.5075,
    longitude: 13.4523,
    capacity: 1500,
  },
  columbiahalle: {
    slug: 'columbiahalle',
    name: 'Columbiahalle',
    addressLine: 'Columbiadamm 13-21, 10965 Berlin',
    city: 'Berlin',
    country: 'DE',
    latitude: 52.4842,
    longitude: 13.3888,
    capacity: 3500,
  },
  festsaal: {
    slug: 'festsaal-kreuzberg',
    name: 'Festsaal Kreuzberg',
    addressLine: 'Am Flutgraben 2, 12435 Berlin',
    city: 'Berlin',
    country: 'DE',
    latitude: 52.4968,
    longitude: 13.4494,
    capacity: 900,
  },
  silentgreen: {
    slug: 'silent-green',
    name: 'Silent Green Kulturquartier',
    addressLine: 'Gerichtstraße 35, 13347 Berlin',
    city: 'Berlin',
    country: 'DE',
    latitude: 52.5497,
    longitude: 13.3746,
    capacity: 500,
  },
  hamburgerbahnhof: {
    slug: 'hamburger-bahnhof',
    name: 'Hamburger Bahnhof',
    addressLine: 'Invalidenstraße 50-51, 10557 Berlin',
    city: 'Berlin',
    country: 'DE',
    latitude: 52.5279,
    longitude: 13.3706,
    capacity: 800,
  },
  kampnagel: {
    slug: 'kampnagel',
    name: 'Kampnagel',
    addressLine: 'Jarrestraße 20, 22303 Hamburg',
    city: 'Hamburg',
    country: 'DE',
    latitude: 53.5875,
    longitude: 10.0206,
    capacity: 1200,
  },
};

function daysFromNow(days, hour = 20) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
}

const SALES_START = daysFromNow(-30, 10);

function tiers(specs) {
  return specs.map(([name, priceCents, quantityTotal, maxPerOrder = 6]) => ({
    name,
    priceCents,
    quantityTotal,
    maxPerOrder,
    salesStartAt: SALES_START,
    salesEndAt: daysFromNow(120, 23),
  }));
}

const EVENTS = [
  {
    venue: VENUES.berghain,
    slug: 'klubnacht-winter-session',
    title: 'Klubnacht: Winter Session',
    description:
      'Sixteen hours across two floors. Resident selectors on the main floor, ambient and experimental upstairs in the Panorama Bar. Doors at midnight, no photography, no exceptions.',
    startsAt: daysFromNow(12, 23),
    ticketTypes: tiers([
      ['Presale', 2200, 400, 4],
      ['Door', 2800, 200, 2],
    ]),
  },
  {
    venue: VENUES.astra,
    slug: 'neukoelln-noise-collective',
    title: 'Neukölln Noise Collective',
    description:
      'Five bands from the Berlin DIY circuit playing loud guitars in a room that was never designed for them. Support from Hamburg and Leipzig.',
    startsAt: daysFromNow(5, 19),
    ticketTypes: tiers([
      ['Early bird', 1600, 150, 4],
      ['General admission', 2400, 600],
      ['Balcony', 3200, 120, 4],
    ]),
  },
  {
    venue: VENUES.columbiahalle,
    slug: 'tempelhof-electronic-night',
    title: 'Tempelhof Electronic Night',
    description:
      'A full live-hardware bill: modular, drum machines, no laptops. Six acts, one stage, running from early evening until two.',
    startsAt: daysFromNow(21, 18),
    ticketTypes: tiers([
      ['Standing', 3900, 2200],
      ['Seated tier', 5400, 600, 4],
      ['VIP + soundcheck', 9800, 60, 2],
    ]),
  },
  {
    venue: VENUES.festsaal,
    slug: 'kreuzberg-jazz-sessions',
    title: 'Kreuzberg Jazz Sessions',
    description:
      'A rotating quartet plus whoever turns up with an instrument. Three sets, long breaks, cheap Sterni. Cash bar only.',
    startsAt: daysFromNow(3, 20),
    ticketTypes: tiers([
      ['Standing', 1800, 320],
      ['Table for two', 4800, 40, 2],
    ]),
  },
  {
    venue: VENUES.silentgreen,
    slug: 'crematorium-ambient-series',
    title: 'Ambient Series in the Crematorium',
    description:
      'Four hours of drone and modular composition in the domed hall of a former crematorium. Seating is on the floor; bring a cushion.',
    startsAt: daysFromNow(9, 19),
    ticketTypes: tiers([
      ['Floor', 2600, 220, 4],
      ['Gallery', 3400, 80, 2],
    ]),
  },
  {
    venue: VENUES.hamburgerbahnhof,
    slug: 'nachtprogramm-late-opening',
    title: 'Nachtprogramm: Late Opening',
    description:
      'The contemporary collection open until midnight, with curator talks on the hour and a live score performed in the main hall.',
    startsAt: daysFromNow(16, 18),
    ticketTypes: tiers([
      ['Entry', 1400, 500],
      ['Entry + guided tour', 2200, 90, 4],
      ['Concession', 800, 150, 2],
    ]),
  },
  {
    venue: VENUES.astra,
    slug: 'ostkreuz-techno-marathon',
    title: 'Ostkreuz Techno Marathon',
    description:
      'Twelve hours, four rooms, thirty-one artists. The kind of line-up that only makes sense if you stop trying to see all of it.',
    startsAt: daysFromNow(34, 22),
    ticketTypes: tiers([
      ['Phase 1', 2900, 800],
      ['Phase 2', 3600, 800],
      ['Last release', 4400, 400, 4],
    ]),
  },
  {
    venue: VENUES.kampnagel,
    slug: 'hamburg-transfer-weekend',
    title: 'Hamburg Transfer Weekend',
    description:
      'A two-day exchange programme with the Berlin scene: performance, sound art and a closing party in the K6 hall.',
    startsAt: daysFromNow(45, 17),
    ticketTypes: tiers([
      ['Day pass', 3200, 400],
      ['Weekend pass', 5600, 250, 4],
    ]),
  },
  {
    venue: VENUES.columbiahalle,
    slug: 'sold-out-showcase',
    title: 'Almost Sold Out: Label Showcase',
    description:
      'Deliberately seeded with very little stock, so the realtime inventory counter and the sold-out path are visible within a minute of starting the stack.',
    startsAt: daysFromNow(7, 20),
    ticketTypes: tiers([
      ['Last few', 4200, 8, 2],
      ['Standing', 3400, 25, 4],
    ]),
  },
];

async function post(path, body, attempt = 1) {
  try {
    const response = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${response.status} ${text.slice(0, 300)}`);
    }
    return response.json();
  } catch (err) {
    // The API's healthcheck has already passed, but Kafka topic creation and
    // the gRPC channel can still be settling on a cold start.
    if (attempt >= 10) throw err;
    await new Promise((r) => setTimeout(r, 2000));
    return post(path, body, attempt + 1);
  }
}

let created = 0;
let skipped = 0;

for (const event of EVENTS) {
  try {
    await post('/events', {
      venue: event.venue,
      slug: event.slug,
      title: event.title,
      description: event.description,
      startsAt: event.startsAt,
      serviceFeeBps: 750,
      currency: 'EUR',
      ticketTypes: event.ticketTypes,
    });
    created += 1;
    console.log(`[seed] created ${event.slug}`);
  } catch (err) {
    skipped += 1;
    console.log(`[seed] skipped ${event.slug}: ${err.message.slice(0, 120)}`);
  }
}

console.log(`[seed] done — ${created} created, ${skipped} skipped`);
