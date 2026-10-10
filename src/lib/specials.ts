export type SpecialType = 'discount' | 'buy_x_get_y' | 'tickets_and_meals';

export type SpecialPricing =
  | { type: 'percentage'; discount: number }
  | { type: 'fixed-off'; discount: number }
  | { type: 'fixed-price'; price: number };

export type SpecialItemDef = {
  itemId: string;
  quantity: number;
};

export type SpecialSnapshot = {
  title: string;
  badge_text?: string;
  type: SpecialType;
  paid_tickets: SpecialItemDef[];
  free_tickets: SpecialItemDef[];
  pricing: SpecialPricing;
  free_meals: number;
  included_meals?: { name: string; quantity: number }[];
};

export type Special = {
  id: string;
  type: SpecialType;
  title: string;
  description: string | null;
  badge_text: string | null;
  paid_tickets: SpecialItemDef[];
  free_tickets: SpecialItemDef[];
  pricing: SpecialPricing;
  free_meals: number;
  included_meals: { name: string; quantity: number }[];
  valid_from: string | null;
  valid_to: string | null;
  valid_weekdays: number[];
  stock_limit: number | null;
  max_per_booking: number | null;
  /** Given free (its free tickets and meals) to online bookings whose cart is over this amount; null = off. */
  auto_apply_min_spend?: number | null;
  active: boolean;
  archived_at: string | null;
  created_at: string;
  /** From /api/specials: how many are left on the requested date (null = no limit). */
  remaining?: number | null;
};

export type BookingSpecialSelection = {
  id: string;
  quantity: number;
  snapshot: SpecialSnapshot;
};
