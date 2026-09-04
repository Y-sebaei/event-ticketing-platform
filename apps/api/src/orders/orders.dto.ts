import { z } from 'zod';

export const checkoutSchema = z.object({
  eventSlug: z.string().min(1),
  customer: z.object({
    email: z.string().email(),
    name: z.string().min(1).max(120),
  }),
  items: z
    .array(z.object({ ticketTypeId: z.string().uuid(), quantity: z.number().int().positive() }))
    .min(1)
    .max(5),
});

export type CheckoutInput = z.infer<typeof checkoutSchema>;
