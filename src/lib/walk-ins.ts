/** Shared by the walk-in sale screen (client) and the walk-in API (server). */

export const GATE_PAYMENT_METHODS = {
  CASH: { code: 'GATE_CASH', label: 'Cash' },
  CARD: { code: 'GATE_CARD', label: 'Card machine' },
  OTHER: { code: 'GATE_OTHER', label: 'Other (SnapScan, EFT…)' },
} as const;

export type GatePaymentKey = keyof typeof GATE_PAYMENT_METHODS;

export const GATE_PAYMENT_LABELS: Record<string, string> = Object.fromEntries(
  Object.values(GATE_PAYMENT_METHODS).map(method => [method.code, `Walk-in: ${method.label}`]),
);

export const isGateSale = (paymentMethod: string | null | undefined) => Boolean(paymentMethod?.startsWith('GATE_'));

export type WalkInTicket = { ticketUid: string; qrToken: string; name: string; status: string };

export type WalkInReceipt = {
  bookingId: string;
  reference: string;
  createdAt: string;
  visitDate: string;
  lines: Array<{ name: string; quantity: number; unitPrice: number; subtotal: number }>;
  total: number;
  people: number;
  paymentMethod: string;
  paymentReference: string;
  amountTendered: number | null;
  change: number | null;
  seating: string[];
  customerName: string;
  checkedIn: boolean;
  emailSent: boolean | null;
  tickets: WalkInTicket[];
  soldBy: string;
};
