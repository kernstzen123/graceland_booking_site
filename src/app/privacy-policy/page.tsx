import Link from 'next/link';
import type { Metadata } from 'next';
import { CookieSettingsButton } from '@/components/GoogleAnalytics';
import { MailIcon } from '@/components/icons';
import { DEFAULT_SUPPORT_EMAIL, REGISTRATION_NUMBER } from '@/lib/business-details';
import { formatLegalDate, PRIVACY_VERSION } from '@/lib/legal';

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How Graceland Venues in Paarl collects, uses and protects your personal information under POPIA.",
  alternates: { canonical: "/privacy-policy" },
};

const SECTIONS = [
  { id: 'who-we-are', title: 'Who we are' },
  { id: 'information-we-collect', title: 'What personal information we collect' },
  { id: 'how-we-use', title: 'How we use your information' },
  { id: 'who-we-share', title: 'Who we share your information with' },
  { id: 'retention', title: 'How long we keep your information' },
  { id: 'security', title: 'How we protect your information' },
  { id: 'your-rights', title: 'Your rights under POPIA' },
  { id: 'children', title: 'Children' },
  { id: 'cookies', title: 'Cookies' },
  { id: 'changes', title: 'Changes to this Policy' },
  { id: 'contact', title: 'Contact us' },
];

const CONTACT_EMAIL = DEFAULT_SUPPORT_EMAIL;

export default function PrivacyPolicy() {
  return (
    <main className="container legal-page">
      <article className="card legal-doc">
        <div className="legal-header">
          <p className="legal-kicker">Graceland Venues</p>
          <h1>Privacy Policy</h1>
          <p>Operated by Ace Contractors &amp; Eng CC, trading as Graceland Venues.</p>
          <p className="legal-updated">Effective date: <strong>22 September 2026</strong> &middot; Last updated: <strong>{formatLegalDate(PRIVACY_VERSION)}</strong></p>
        </div>

        <div className="legal-body">
          <p style={{ color: '#334155', marginBottom: '1rem', lineHeight: 1.65 }}>Ace Contractors &amp; Eng CC, trading as Graceland Venues (&quot;Graceland Venues&quot;, &quot;we&quot;, &quot;us&quot;, &quot;our&quot;), respects your privacy and is committed to protecting your personal information. This Privacy Policy explains what personal information we collect through our website and booking system, why we collect it, how we use and protect it, and what rights you have, in accordance with the Protection of Personal Information Act 4 of 2013 (&quot;POPIA&quot;).</p>
          <p style={{ color: '#334155', marginBottom: '1.5rem', lineHeight: 1.65 }}>By using our website, making a booking, or otherwise providing us with personal information, you agree to the collection and use of information in accordance with this Policy. If you do not agree with this Policy, please do not use our website or booking system.</p>

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

          <section id="who-we-are" className="legal-section">
            <h2>1. Who we are</h2>
            <table className="legal-table">
              <tbody>
                <tr><td className="legal-table-label">Legal entity</td><td>Ace Contractors &amp; Eng CC, trading as Graceland Venues</td></tr>
                <tr><td className="legal-table-label">CC registration number</td><td>{REGISTRATION_NUMBER}</td></tr>
                <tr><td className="legal-table-label">Physical address</td><td>Lustigan Road, Southern Paarl, 7620, Western Cape, South Africa</td></tr>
                <tr><td className="legal-table-label">Contact email</td><td><a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></td></tr>
              </tbody>
            </table>

            <h3>Information Officer</h3>
            <p>Under POPIA, every organisation that processes personal information must have a designated Information Officer, responsible for compliance and for handling requests and complaints regarding personal information.</p>
            <table className="legal-table">
              <tbody>
                <tr><td className="legal-table-label">Information Officer</td><td>Conny</td></tr>
                <tr><td className="legal-table-label">Contact</td><td><a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></td></tr>
              </tbody>
            </table>
          </section>

          <section id="information-we-collect" className="legal-section">
            <h2>2. What personal information we collect</h2>

            <h3>2.1 Information you give us when booking</h3>
            <p>When you make a booking through our website, we collect:</p>
            <ul>
              <li>Full name</li>
              <li>Email address</li>
              <li>Phone number</li>
              <li>Your chosen visit date and details of your booking (number of guests, package selected, hut or table selection, party details, and similar booking preferences)</li>
            </ul>
            <p>A booking may only be made by an adult. Graceland Venues does not knowingly collect personal information directly from children through our website — see section 8 (Children) below.</p>

            <h3>2.2 Proof of payment (EFT bookings)</h3>
            <p>If you choose to pay by manual EFT, we ask you to upload a proof of payment. This document may show your bank name and, depending on your bank&apos;s statement format, a partially masked account number. We store this proof solely to verify and process your payment.</p>

            <h3>2.3 Card and payment information (PayFast)</h3>
            <p>If you pay by card, your payment is processed directly by PayFast (Pty) Ltd, our third-party payment gateway. Graceland Venues does not receive, see, or store your card number, expiry date, or CVV. PayFast processes this information under its own privacy policy and security standards.</p>

            <h3>2.4 Website usage information (cookies and analytics)</h3>
            <p>Our website uses:</p>
            <ul>
              <li><strong>Vercel Web Analytics and Speed Insights</strong> — to count visitors and measure how quickly our pages load. These tools do not use cookies and do not identify you: they record aggregated information such as the pages visited, the referring website, country, and device and browser type.</li>
              <li><strong>Google Analytics</strong> — <em>only if you accept analytics cookies</em> when you first visit our website. It helps us understand how visitors find and use our website, by recording information such as the pages you visit, how you arrived at our website, your approximate location (city and country), and your device and browser type. It uses cookies to recognise return visits (see section 9). We have switched off Google&apos;s advertising features, and we do not send your name, email address, phone number or booking reference to Google.</li>
              <li><strong>Sentry</strong> — if something goes wrong on our website, a technical error report (the page, browser and device type, and what went wrong) is sent to Sentry so we can fix it. It is configured not to include your booking or payment details.</li>
            </ul>
            <p>We do not use advertising cookies. Google Analytics cookies are only set if you accept them, and you can change your choice at any time (see section 9).</p>

            <h3>2.5 CCTV</h3>
            <p>Our premises are monitored by CCTV for the safety and security of our visitors, staff and property. Footage may capture your image while you are on site. CCTV footage is used only for safety, security, and incident-investigation purposes, is stored securely, and is only accessed by authorised personnel.</p>
          </section>

          <section id="how-we-use" className="legal-section">
            <h2>3. How we use your information</h2>
            <p>We use the personal information we collect to:</p>
            <ul>
              <li>Process and confirm your booking, and send you booking confirmations, tickets (including QR codes), and payment-related communication</li>
              <li>Verify manual EFT payments against the proof of payment you upload</li>
              <li>Communicate with you about your booking, including changes, cancellations, or issues that require your attention</li>
              <li>Allow our staff to check you in at the venue using your ticket&apos;s QR code</li>
              <li>Maintain the security of our website and premises</li>
              <li>Understand and improve how visitors use our website, using the analytics tools described above</li>
              <li>Comply with our legal, financial and tax record-keeping obligations</li>
            </ul>

            <h3>3.1 We do not use your information for marketing</h3>
            <div className="callout callout-success">
              <p>We only ever use your email address and phone number for transactional communication directly related to your booking (such as confirmations, tickets, payment instructions, and check-in-related messages). We do not send marketing emails, newsletters, or promotional messages using the information collected through bookings, and we do not sell or rent your personal information to any third party for marketing purposes.</p>
            </div>
          </section>

          <section id="who-we-share" className="legal-section">
            <h2>4. Who we share your information with</h2>
            <p>We do not sell your personal information. We share personal information only with the following categories of third-party service providers, strictly to the extent necessary to operate our booking system:</p>
            <div style={{ overflowX: 'auto' }}>
              <table className="legal-table">
                <thead>
                  <tr><th>Provider</th><th>Purpose</th><th>What they process</th></tr>
                </thead>
                <tbody>
                  <tr>
                    <td>PayFast (Pty) Ltd</td>
                    <td>Card payment processing</td>
                    <td>Payment and transaction details, including card information (Graceland Venues does not receive card details)</td>
                  </tr>
                  <tr>
                    <td>Supabase</td>
                    <td>Database and file storage for our booking system</td>
                    <td>Booking, customer, and proof-of-payment data</td>
                  </tr>
                  <tr>
                    <td>Vercel Inc.</td>
                    <td>Website hosting and performance analytics</td>
                    <td>Website usage data; hosts our website and booking system</td>
                  </tr>
                  <tr>
                    <td>Resend</td>
                    <td>Sending booking confirmation and ticket emails</td>
                    <td>Name, email address, and booking/ticket details necessary to deliver emails</td>
                  </tr>
                  <tr>
                    <td>Google (Google Ireland Limited and Google LLC)</td>
                    <td>Website analytics (Google Analytics), only if you accept analytics cookies</td>
                    <td>Pages visited, how you arrived at our website, approximate location, device and browser type, and a random cookie identifier; not your name, contact details or booking details</td>
                  </tr>
                  <tr>
                    <td>Sentry (Functional Software Inc.)</td>
                    <td>Error monitoring, so we can fix problems with the website</td>
                    <td>Technical error reports (the page, browser and device type, and what went wrong); configured not to include your booking or payment details</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>We may also disclose personal information where required by law, to comply with a legal process, to protect our rights or property, or to protect the safety of our visitors, staff or the public.</p>

            <h3>4.1 Cross-border transfer of information</h3>
            <p>Some of the service providers listed above may store or process personal information on servers located outside South Africa (for example, in the United States or the European Union). Where this occurs, we take reasonable steps to ensure that these providers apply an adequate level of protection to your personal information, consistent with the requirements of POPIA, including relying on providers with recognised international security and data protection standards.</p>
          </section>

          <section id="retention" className="legal-section">
            <h2>5. How long we keep your information</h2>
            <p>We keep booking and customer information, including proof-of-payment documents, only for as long as we need it: to provide your booking, to deal with queries, refunds and rebooking vouchers (which do not expire), and to meet our legal obligations, such as tax and financial record-keeping (South African law generally requires these records to be kept for five years). When we no longer need information, we securely delete or anonymise it. You may ask us to delete your information sooner (see section 7), unless we are required to keep it. Google Analytics data is kept for no longer than 14 months and is then deleted automatically. CCTV footage is retained for a limited period necessary for security purposes and is then automatically overwritten or deleted, unless required for an ongoing investigation.</p>
          </section>

          <section id="security" className="legal-section">
            <h2>6. How we protect your information</h2>
            <p>We take reasonable technical and organisational measures to protect your personal information against loss, unauthorised access, alteration, or disclosure, including:</p>
            <ul>
              <li>Encrypted transmission of data (HTTPS) between your browser and our website</li>
              <li>Access controls restricting staff access to personal information based on role</li>
              <li>Secure, access-controlled storage of proof-of-payment documents</li>
              <li>Not storing your card details on our own systems — these are handled directly by PayFast</li>
            </ul>
            <p>No method of transmission or storage is completely secure. While we work to protect your personal information, we cannot guarantee its absolute security.</p>
          </section>

          <section id="your-rights" className="legal-section">
            <h2>7. Your rights under POPIA</h2>
            <p>Subject to POPIA, you have the right to:</p>
            <ul>
              <li><strong>Access</strong> the personal information we hold about you</li>
              <li><strong>Request correction</strong> of inaccurate, outdated, or incomplete personal information</li>
              <li><strong>Request deletion</strong> of your personal information, subject to our legal and financial record-keeping obligations</li>
              <li><strong>Object</strong> to the processing of your personal information in certain circumstances</li>
              <li><strong>Withdraw consent</strong> where our processing is based on your consent, without affecting the lawfulness of processing carried out before withdrawal</li>
              <li><strong>Lodge a complaint</strong> with the Information Regulator of South Africa if you believe your personal information has been processed unlawfully</li>
            </ul>
            <p>To exercise any of these rights, please contact us at <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. We will respond to your request within a reasonable time, and in any event within the timeframes required by POPIA.</p>

            <h3>7.1 Complaints to the Information Regulator</h3>
            <p>You have the right to lodge a complaint with South Africa&apos;s Information Regulator if you are unhappy with how we have handled your personal information:</p>
            <table className="legal-table">
              <tbody>
                <tr><td className="legal-table-label">Website</td><td><a href="https://www.inforegulator.org.za" target="_blank" rel="noopener noreferrer">www.inforegulator.org.za</a></td></tr>
                <tr><td className="legal-table-label">Email</td><td><a href="mailto:complaints.IR@justice.gov.za">complaints.IR@justice.gov.za</a></td></tr>
              </tbody>
            </table>
          </section>

          <section id="children" className="legal-section">
            <h2>8. Children</h2>
            <p>Our booking system is designed to be used by adults. A booking may only be made by an adult, who is responsible for the accuracy of the information provided, including details relating to any children included in the booking party. We do not knowingly collect personal information directly from children through our website. If you believe a child has provided us with personal information directly, please contact us at <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> and we will take steps to delete it.</p>
          </section>

          <section id="cookies" className="legal-section">
            <h2>9. Cookies</h2>
            <p>Cookies are small text files placed on your device when you visit our website. We do not use advertising cookies.</p>
            <ul>
              <li><strong>Analytics cookies (optional).</strong> When you first visit our website, we ask whether you accept Google Analytics cookies. Only if you accept, Google Analytics sets cookies named <code>_ga</code> and <code>_ga_…</code>, which recognise return visits and last for up to 2 years. If you decline, no analytics cookies are set. Your choice is remembered in your browser&apos;s local storage.</li>
              <li><strong>Cookie-free analytics.</strong> Vercel Web Analytics and Speed Insights (section 2.4) work without cookies.</li>
              <li><strong>Booking details.</strong> While you make a booking, your browser keeps your booking details in its own session storage so they are not lost if you are sent to PayFast and back; this is cleared when you close the browser tab.</li>
              <li><strong>Staff sign-in.</strong> Staff who sign in to our staff portal receive a sign-in cookie, which is strictly necessary for that portal to work. Google Analytics never runs on the staff portal.</li>
            </ul>
            <p>You can change or withdraw your analytics choice at any time: <CookieSettingsButton label="change my cookie choice" />. You can also delete cookies in your browser settings.</p>
          </section>

          <section id="changes" className="legal-section">
            <h2>10. Changes to this Policy</h2>
            <p>We may update this Privacy Policy from time to time to reflect changes in our practices, our service providers, or legal requirements. Any changes will be posted on this page with an updated &quot;Last updated&quot; date. We encourage you to review this Policy periodically.</p>
          </section>

          <section id="contact" className="legal-section">
            <h2>11. Contact us</h2>
            <p>If you have any questions, concerns, or requests regarding this Privacy Policy or how we handle your personal information, please contact us:</p>
            <div className="legal-contact-card">
              <strong>Graceland Venues</strong>
              <span>Ace Contractors &amp; Eng CC t/a Graceland Venues (Reg. no. {REGISTRATION_NUMBER})</span>
              <span>Lustigan Road, Southern Paarl, 7620</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><MailIcon /> <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></span>
            </div>
          </section>

          <div className="legal-footer-nav">
            <Link className="btn btn-primary" href="/">Back to booking</Link>
            <Link className="btn btn-secondary" href="/terms-and-conditions">View Terms &amp; Conditions</Link>
          </div>
        </div>
      </article>
    </main>
  );
}
