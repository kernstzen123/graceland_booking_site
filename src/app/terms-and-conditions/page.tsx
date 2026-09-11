import Link from 'next/link';

export default function TermsAndConditions() {
  return (
    <main className="container" style={{ padding: '3rem 1rem' }}>
      <article className="card" style={{ maxWidth: 850, margin: '0 auto' }}>
        <p style={{ color: 'var(--primary)', fontWeight: 700 }}>GRACELAND VENUES</p>
        <h1>Booking Terms and Conditions</h1>
        <p style={{ color: 'var(--text-muted)' }}>Last updated: September 9, 2026</p>

        <h2>Introduction</h2>
        <p>Welcome to Graceland Venues, located at Lustigan Road, Southern Paarl, 7620. These terms and conditions govern your booking and use of our venue and facilities.</p>

        <h2>Reschedule policy</h2>
        <ul>
          <li>Ticket dates may be rescheduled provided the client changes no later than 24 hours prior to the original booking date.</li>
          <li>Requests to change the booking made less than 12 hours before the scheduled date will not be accepted.</li>
          <li>Tickets that have been rescheduled are only valid until the end of the applicable summer season. For example, tickets purchased for 2026/2027 summer season are valid from 1 September 2026 until 30 April 2027.</li>
          <li>Unused tickets will expire at the end of the applicable summer season and may not be carried over to the following season.</li>
        </ul>

        <h2>Cancellation policy</h2>
        <h3>Graceland venues cancellation:</h3>
        <p>In the event of Graceland Venues cancelling the client&apos;s reservation due to unforeseen circumstances i.e. severe weather, acts of nature. The client will have the option to postpone a date within the applicable summer season or receive a full refund within 30 days.</p>

        <h3>Client cancellation:</h3>
        <p>Cancellation of orders by the client will attract the following administration fees:</p>
        <ul>
          <li>10% administration fee of the cancelled order value for cancellation requests made over 14 days prior to the scheduled booking start time and date.</li>
          <li>15% administration fee of the cancelled order value for cancellation requests made between 24 hours and 14 days prior to the scheduled booking start time and date.</li>
          <li>20% administration fee of the cancelled order value for cancellation requests made within 24 hours prior to the scheduled booking start time and date.</li>
        </ul>

        <h2>No show policy</h2>
        <p>Bookings are non-refundable and non-transferable if the client fails to arrive for their scheduled booking. No refunds, credits, or postponements will be provided for missed bookings or no shows.</p>

        <h2>Terms and conditions policy</h2>
        <ul>
          <li>Clients must always have a wrist band on. Wrist bands are not transferrable.</li>
          <li>All visitors and guests are required to comply with Graceland Venues rules, regulations, safety requirements and all instructions displayed on the boards notices throughout the premises.</li>
          <li>Should any person fail to comply with these rules or instructions, Graceland Venues reserves the right, at its sole discretion, to refuse entry or require the person to leave the premises immediately, without entitlement to a refund.</li>
          <li>The performance, operating times, pricing, availability and other operations of the water slides, and other facilities are subject to change without prior notice. Such changes shall be made at the discretion of Graceland Venues management and will not automatically entitle customers to a refund or compensation.</li>
          <li>Parents, guardians and accompanying adults are responsible for the supervision and safety of their children at all times while on the Graceland Venues premises, including in and around the swimming pool, water slides, and other facilities. Children must not be left unattended at any time.</li>
          <li>Abusive, threatening, disrespectful or inappropriate behavior towards Graceland Venues staff or fellow clients will not be tolerated. Any person engaging in such behavior may be required to leave the premises immediately and may be refused future entry, without entitlement to a refund.</li>
        </ul>

        <h2>Limitation of liability</h2>
        <p>To the fullest extent permitted by the law, Graceland Venues and its management, employees and representatives shall not be held liable for loss, damages, injury or expense sustained by any person on or in connection with the premises, facilities, services or events, howsoever arising.</p>

        <h2>Payment options and verification</h2>
        <p>Bookings are processed securely through our platform. We accept online payments via PayFast and manual Electronic Funds Transfers (EFT).</p>
        <ul>
          <li><strong>PayFast:</strong> Payments made via PayFast are confirmed automatically.</li>
          <li><strong>Manual EFT:</strong> Payments made via manual EFT require the client to upload a valid proof of payment. The booking remains pending and is only confirmed once verified by our administrative team.</li>
        </ul>

        <h2>Ticketing and Venue access</h2>
        <p>Upon successful payment and verification, clients will receive their booking confirmation and QR codes. These QR codes must be presented for scanning upon arrival at Graceland Venues.</p>

        <h2>Contact information</h2>
        <p>For any inquiries, cancellations, or assistance, please contact us at:</p>
        <ul>
          <li>Email: <a href="mailto:info@gracelandvenues.co.za">info@gracelandvenues.co.za</a></li>
          <li>Phone: 072 264 4009</li>
        </ul>

        <div style={{ marginTop: '2rem' }}>
          <Link className="btn" href="/">Back to booking</Link>
        </div>
      </article>
    </main>
  );
}
