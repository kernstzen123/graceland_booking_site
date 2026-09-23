import Link from 'next/link';
import { MailIcon, PhoneIcon } from '@/components/icons';

const SECTIONS = [
  { id: 'introduction', title: 'Introduction' },
  { id: 'reschedule', title: 'Reschedule policy' },
  { id: 'cancellation', title: 'Cancellation policy' },
  { id: 'no-show', title: 'No show policy' },
  { id: 'terms-policy', title: 'Terms and conditions policy' },
  { id: 'liability', title: 'Limitation of liability' },
  { id: 'payment', title: 'Payment options and verification' },
  { id: 'ticketing', title: 'Ticketing and venue access' },
  { id: 'contact', title: 'Contact information' },
];

export default function TermsAndConditions() {
  return (
    <main className="container legal-page">
      <article className="card legal-doc">
        <div className="legal-header">
          <p className="legal-kicker">Graceland Venues</p>
          <h1>Booking Terms and Conditions</h1>
          <p>Please read these terms carefully before booking your visit.</p>
          <p className="legal-updated">Last updated: <strong>September 9, 2026</strong></p>
        </div>

        <div className="legal-body">
          <nav className="legal-toc" aria-label="Table of contents">
            <p className="legal-toc-title">On this page</p>
            <ol>
              {SECTIONS.map(section => (
                <li key={section.id}>
                  <a href={`#${section.id}`}>{section.title}</a>
                </li>
              ))}
            </ol>
          </nav>

          <section id="introduction" className="legal-section">
            <h2>Introduction</h2>
            <p>Welcome to Graceland Venues, located at Lustigan Road, Southern Paarl, 7620. These terms and conditions govern your booking and use of our venue and facilities.</p>
          </section>

          <section id="reschedule" className="legal-section">
            <h2>Reschedule policy</h2>
            <ul>
              <li>Ticket dates may be rescheduled provided the client changes no later than 24 hours prior to the original booking date.</li>
              <li>Requests to change the booking made less than 12 hours before the scheduled date will not be accepted.</li>
              <li>Tickets that have been rescheduled are only valid until the end of the applicable summer season. For example, tickets purchased for 2026/2027 summer season are valid from 1 September 2026 until 30 April 2027.</li>
              <li>Unused tickets will expire at the end of the applicable summer season and may not be carried over to the following season.</li>
            </ul>
          </section>

          <section id="cancellation" className="legal-section">
            <h2>Cancellation policy</h2>

            <h3>Graceland venues cancellation</h3>
            <div className="callout callout-info">
              <p>In the event of Graceland Venues cancelling the client&apos;s reservation due to unforeseen circumstances i.e. severe weather, acts of nature, the client will have the option to postpone a date within the applicable summer season or receive a full refund within 30 days.</p>
            </div>

            <h3>Client cancellation</h3>
            <p>Cancellation of orders by the client will attract the following administration fees:</p>
            <table className="legal-fee-table">
              <thead>
                <tr>
                  <th>Timing of cancellation request</th>
                  <th>Fee</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Made over 14 days prior to the scheduled booking start time and date</td>
                  <td>10%</td>
                </tr>
                <tr>
                  <td>Made between 24 hours and 14 days prior to the scheduled booking start time and date</td>
                  <td>15%</td>
                </tr>
                <tr>
                  <td>Made within 24 hours prior to the scheduled booking start time and date</td>
                  <td>20%</td>
                </tr>
              </tbody>
            </table>
            <p>Administration fees are calculated as a percentage of the cancelled order value.</p>
          </section>

          <section id="no-show" className="legal-section">
            <h2>No show policy</h2>
            <div className="callout callout-danger">
              <p>Bookings are non-refundable and non-transferable if the client fails to arrive for their scheduled booking. No refunds, credits, or postponements will be provided for missed bookings or no shows.</p>
            </div>
          </section>

          <section id="terms-policy" className="legal-section">
            <h2>Terms and conditions policy</h2>
            <ul>
              <li>Clients must always have a wrist band on. Wrist bands are not transferrable.</li>
              <li>All visitors and guests are required to comply with Graceland Venues rules, regulations, safety requirements and all instructions displayed on the boards notices throughout the premises.</li>
              <li>Should any person fail to comply with these rules or instructions, Graceland Venues reserves the right, at its sole discretion, to refuse entry or require the person to leave the premises immediately, without entitlement to a refund.</li>
              <li>The performance, operating times, pricing, availability and other operations of the water slides, and other facilities are subject to change without prior notice. Such changes shall be made at the discretion of Graceland Venues management and will not automatically entitle customers to a refund or compensation.</li>
              <li>Parents, guardians and accompanying adults are responsible for the supervision and safety of their children at all times while on the Graceland Venues premises, including in and around the swimming pool, water slides, and other facilities. Children must not be left unattended at any time.</li>
              <li>Abusive, threatening, disrespectful or inappropriate behavior towards Graceland Venues staff or fellow clients will not be tolerated. Any person engaging in such behavior may be required to leave the premises immediately and may be refused future entry, without entitlement to a refund.</li>
            </ul>
          </section>

          <section id="liability" className="legal-section">
            <h2>Limitation of liability</h2>
            <p>To the fullest extent permitted by the law, Graceland Venues and its management, employees and representatives shall not be held liable for loss, damages, injury or expense sustained by any person on or in connection with the premises, facilities, services or events, howsoever arising.</p>
          </section>

          <section id="payment" className="legal-section">
            <h2>Payment options and verification</h2>
            <p>Bookings are processed securely through our platform. We accept online payments via PayFast and manual Electronic Funds Transfers (EFT).</p>
            <div className="legal-payment-methods">
              <div className="legal-payment-method">
                <p className="legal-payment-method-title">
                  <span className="legal-payment-dot" style={{ background: 'var(--success)' }} />
                  PayFast
                </p>
                <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-muted)' }}>Payments made via PayFast are confirmed automatically.</p>
              </div>
              <div className="legal-payment-method">
                <p className="legal-payment-method-title">
                  <span className="legal-payment-dot" style={{ background: 'var(--warning)' }} />
                  Manual EFT
                </p>
                <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-muted)' }}>Requires the client to upload a valid proof of payment. The booking remains pending and is only confirmed once verified by our administrative team.</p>
              </div>
            </div>
          </section>

          <section id="ticketing" className="legal-section">
            <h2>Ticketing and venue access</h2>
            <p>Upon successful payment and verification, clients will receive their booking confirmation and QR codes. These QR codes must be presented for scanning upon arrival at Graceland Venues.</p>
          </section>

          <section id="contact" className="legal-section">
            <h2>Contact information</h2>
            <p>For any inquiries, cancellations, or assistance, please contact us at:</p>
            <div className="legal-contact-card">
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><MailIcon /> <a href="mailto:info@gracelandvenues.co.za">info@gracelandvenues.co.za</a></span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><PhoneIcon /> 072 264 4009</span>
            </div>
          </section>

          <div className="legal-footer-nav">
            <Link className="btn btn-primary" href="/">Back to booking</Link>
            <Link className="btn btn-secondary" href="/privacy-policy">View Privacy Policy</Link>
          </div>
        </div>
      </article>
    </main>
  );
}
