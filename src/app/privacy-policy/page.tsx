import Link from 'next/link';

const SECTIONS = [
  { id: 'introduction', title: 'Introduction' },
  { id: 'information-we-collect', title: 'Information We Collect' },
  { id: 'how-we-use', title: 'How We Use Your Information' },
  { id: 'sharing', title: 'Sharing Your Information' },
  { id: 'retention', title: 'Data Retention' },
  { id: 'security', title: 'Data Security' },
  { id: 'your-rights', title: 'Your Rights' },
  { id: 'cookies', title: 'Cookies' },
  { id: 'children', title: "Children's Information" },
  { id: 'changes', title: 'Changes' },
  { id: 'contact', title: 'Contact Us' },
];

export default function PrivacyPolicy() {
  return (
    <main className="container legal-page">
      <article className="card legal-doc">
        <div className="legal-hero">
          <p className="legal-kicker">Graceland Venues</p>
          <h1>Privacy Policy</h1>
          <p>How we collect, use, and protect your personal information.</p>
          <span className="legal-updated-badge">🕑 Last updated: 20 August 2026</span>
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
            <h2>1. Introduction</h2>
            <p>This Privacy Policy explains how Graceland Venues (&quot;we&quot;, &quot;us&quot;, &quot;our&quot;) collects, uses, stores, and protects your personal information when you use this website to book tickets, make payments, or otherwise interact with our services.</p>
            <p>We are committed to protecting your privacy in accordance with the Protection of Personal Information Act 4 of 2013 (POPIA).</p>
            <div className="legal-callout legal-callout-info">
              <p>Our Information Officer can be contacted at <a href="mailto:conny@gracelandvenues.co.za">conny@gracelandvenues.co.za</a> or +27 72 264 4009.</p>
            </div>
          </section>

          <section id="information-we-collect" className="legal-section">
            <h2>2. Information We Collect</h2>
            <p>We may collect your full name, email address, phone number, booking details, payment information processed by our payment providers, proof-of-payment documents for manual EFT bookings, communications you send us, and basic technical data such as IP address, browser type, and device type.</p>
            <p>We do not knowingly collect sensitive personal information unless it is specifically required for a particular booking type, in which case we will ask for explicit consent.</p>
          </section>

          <section id="how-we-use" className="legal-section">
            <h2>3. How We Use Your Information</h2>
            <ul>
              <li>Process and confirm your booking.</li>
              <li>Generate and deliver QR-code entry tickets.</li>
              <li>Verify payments and proof-of-payment uploads.</li>
              <li>Communicate booking confirmations, changes, or closures.</li>
              <li>Respond to support queries and improve our services.</li>
              <li>Comply with legal and tax record-keeping obligations.</li>
            </ul>
            <p>We do not sell your personal information.</p>
          </section>

          <section id="sharing" className="legal-section">
            <h2>4. Sharing Your Information</h2>
            <p>Necessary information may be shared with operators who help us provide the service:</p>
            <ul>
              <li>PayFast and Yoco for payment processing. We do not store your full card details.</li>
              <li>Supabase for securely storing booking records and proof-of-payment uploads.</li>
              <li>Resend for delivering booking confirmations and QR tickets.</li>
            </ul>
            <p>We only share what is necessary for these providers to perform their functions. We may disclose information where required by law or to protect our legal rights.</p>
          </section>

          <section id="retention" className="legal-section">
            <h2>5. Data Retention</h2>
            <p>We retain booking and payment records for as long as necessary and thereafter as required by South African tax and financial record-keeping laws. Proof-of-payment files are retained for the same audit purposes.</p>
          </section>

          <section id="security" className="legal-section">
            <h2>6. Data Security</h2>
            <p>We use HTTPS/SSL, access controls, secure non-public storage for proof uploads, and regular security reviews. No internet transmission or storage system is completely secure.</p>
          </section>

          <section id="your-rights" className="legal-section">
            <h2>7. Your Rights</h2>
            <p>Under POPIA, you may request access to, correction or deletion of your personal information, subject to legal retention obligations; object to direct marketing; and lodge a complaint with the Information Regulator of South Africa. Contact <a href="mailto:conny@gracelandvenues.co.za">conny@gracelandvenues.co.za</a> to exercise these rights.</p>
          </section>

          <section id="cookies" className="legal-section">
            <h2>8. Cookies</h2>
            <p>We may use essential cookies required for the booking process. We do not use third-party advertising or tracking cookies without consent.</p>
          </section>

          <section id="children" className="legal-section">
            <h2>9. Children&apos;s Information</h2>
            <p>Our services are intended for adults booking for themselves, their families, or groups. Bookings involving minors must be made and consented to by a parent or legal guardian.</p>
          </section>

          <section id="changes" className="legal-section">
            <h2>10. Changes</h2>
            <p>We may update this policy from time to time. The date above will reflect the latest revision.</p>
          </section>

          <section id="contact" className="legal-section">
            <h2>11. Contact Us</h2>
            <div className="legal-contact-card">
              <strong>Graceland Venues</strong>
              <span>✉️ <a href="mailto:conny@gracelandvenues.co.za">conny@gracelandvenues.co.za</a></span>
              <span>📞 072 264 4009</span>
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
