import Link from 'next/link';
import { MailIcon } from '@/components/icons';

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

const CONTACT_EMAIL = 'support@graceland-venues.co.za';

export default function PrivacyPolicy() {
  return (
    <main className="container legal-page">
      <article className="card legal-doc">
        <div className="legal-header">
          <p className="legal-kicker">Graceland Venues</p>
          <h1>Privacy Policy</h1>
          <p>Operated by Ace Contractors &amp; Eng CC, trading as Graceland Venues.</p>
          <p className="legal-updated">Effective date: <strong>22 September 2026</strong> &middot; Last updated: <strong>22 September 2026</strong></p>
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
                <tr><td className="legal-table-label">CC registration number</td><td>Registration pending</td></tr>
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
              <li><strong>Google Analytics</strong> — to understand how visitors use our website (pages visited, time on site, general location, device and browser type).</li>
              <li><strong>Vercel Analytics</strong> — to measure website performance and visitor traffic.</li>
            </ul>
            <p>These tools may place cookies or use similar technologies on your device and may process information in an identifiable or pseudonymised form. You can control or disable cookies through your browser settings, and you can opt out of Google Analytics tracking using the Google Analytics Opt-out Browser Add-on (tools.google.com/dlpage/gaoptout). Disabling cookies may affect how parts of the website function, but will not prevent you from making a booking.</p>

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
                    <td>Google Analytics</td>
                    <td>Website analytics</td>
                    <td>Website usage and device/browser data</td>
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
            <p>We retain booking and customer information, including proof-of-payment documents, for <strong>1 year</strong> from the date of your visit or transaction, after which it is securely deleted or anonymised, unless we are required by law (for example, tax or financial record-keeping obligations) to retain it for longer. CCTV footage is retained for a limited period necessary for security purposes and is then automatically overwritten or deleted, unless required for an ongoing investigation.</p>
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
            <p>Cookies are small text files placed on your device when you visit our website. We use cookies and similar technologies (via Google Analytics and Vercel Analytics, as described in section 2.4) to understand website usage and improve performance. You can manage or disable cookies at any time through your browser settings. Please note that some parts of our website may not function as intended if cookies are disabled.</p>
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
              <span>Ace Contractors &amp; Eng CC t/a Graceland Venues</span>
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
