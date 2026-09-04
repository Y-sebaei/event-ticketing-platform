import { z } from 'zod';

export const createEventSchema = z.object({
  venue: z.object({
    slug: z.string().min(1),
    name: z.string().min(1),
    addressLine: z.string().min(1),
    city: z.string().min(1),
    country: z.string().length(2).default('DE'),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    capacity: z.number().int().positive(),
  }),
  slug: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(''),
  startsAt: z.string().datetime({ offset: true }),
  doorsAt: z.string().datetime({ offset: true }).optional(),
  serviceFeeBps: z.number().int().min(0).max(10_000).default(750),
  currency: z.string().length(3).default('EUR'),
  ticketTypes: z
    .array(
      z.object({
        name: z.string().min(1),
        priceCents: z.number().int().nonnegative(),
        quantityTotal: z.number().int().positive(),
        maxPerOrder: z.number().int().min(1).max(10).default(6),
        salesStartAt: z.string().datetime({ offset: true }),
        salesEndAt: z.string().datetime({ offset: true }),
      }),
    )
    .min(1),
});

export type CreateEventInput = z.infer<typeof createEventSchema>;
