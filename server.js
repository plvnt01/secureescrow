// server.js — CommonJS
const express = require('express');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------- security & basics ---------- */
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));

/* ---------- static files ---------- */
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- storage folder ---------- */
const SAVE_FOLDER = path.join(__dirname, 'EscrowRecords');
if (!fs.existsSync(SAVE_FOLDER)) fs.mkdirSync(SAVE_FOLDER, { recursive: true });

/* ---------- email transport (Gmail app password) ---------- */
const COMPANY_EMAIL  = process.env.COMPANY_EMAIL || "escrowservicecopyright@gmail.com";
// Accept either COMPANY_EMAIL_PASS or EMAIL_PASSWORD env var
const COMPANY_EMAIL_PASS = process.env.COMPANY_EMAIL_PASS || process.env.EMAIL_PASSWORD || "";

let transporter = null;
if (COMPANY_EMAIL_PASS) {
  transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: COMPANY_EMAIL, pass: COMPANY_EMAIL_PASS },
  });
}

/* ---------- helpers ---------- */
const currency = (n) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
    .format(Number(n || 0));

const stamp = () => {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

const today = () => new Date().toLocaleDateString('en-US');

/* ---------- PDF invoice generator ---------- */
function createInvoicePDF(data, outPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);

    // Header
    const logoPath = path.join(__dirname, 'public', 'logo.png');
    if (fs.existsSync(logoPath)) doc.image(logoPath, 50, 40, { width: 64 });
    doc.fillColor('#0b3a91').fontSize(22).text('SecureEscrow', 120, 50, { align: 'left' });
    doc.moveDown();

    // Invoice title
    doc.fillColor('#111').fontSize(18).text('INVOICE', 50, 120);

    // Meta
    doc.fontSize(10).fillColor('#333');
    doc.text(`Invoice #: ${data.invoiceNo}`, 50, 145);
    doc.text(`Date    : ${today()}`, 50, 160);

    // Bill to
    doc.moveDown(0.5);
    doc.fontSize(12).fillColor('#111').text('Bill To', 50, 185);
    doc.fontSize(10).fillColor('#333');
    doc.text(`${data.firstName || ''} ${data.lastName || ''}`);
    if (data.email) doc.text(data.email);
    if (data.phone) doc.text(data.phone);

    // Divider
    doc.moveTo(50, 220).lineTo(545, 220).strokeColor('#ddd').stroke();

    // Summary
    doc.fillColor('#111').fontSize(12).text('Summary', 50, 240);
    doc.fontSize(10).fillColor('#333');
    doc.text(`Role          : ${data.role || '-'}`, 50, 260);
    doc.text(`Platform      : ${data.platform || '-'}`, 50, 275);
    if (data.packageName) {
      doc.text(`Package       : ${data.packageName} (${currency(data.packagePrice)})`, 50, 290);
    }
    doc.text(`Payment Plan  : ${data.paymentPlan === 'milestone' ? 'Milestone / Down payment' : 'Full payment'}`, 50, 305);
    if (data.paymentPlan === 'milestone') {
      const dv = data.downType === 'percent' ? `${data.downValue}%` : currency(data.downValue);
      doc.text(`Down Payment  : ${dv}${data.milestoneNotes ? ' | ' + data.milestoneNotes : ''}`, 50, 320);
    }
    doc.text(`Payment Method: ${data.paymentMethod || '-'}`, 50, 335);

    // Item / service
    const desc = (data.itemDetails || '').trim() || '—';
    doc.fillColor('#111').fontSize(12).text('Item / Service', 50, 360);
    doc.fontSize(10).fillColor('#333').text(desc, 50, 378, { width: 495 });

    // Amounts box
    const y0 = doc.y + 16;
    doc.roundedRect(50, y0, 495, 110, 6).strokeColor('#ddd').stroke();
    doc.fontSize(11).fillColor('#111').text('Totals', 60, y0 + 10);
    doc.fontSize(10).fillColor('#333');
    doc.text(`Subtotal: ${currency(data.amount)}`, 60, y0 + 30);
    if (data.downPayment > 0) doc.text(`Down Payment Due Now: ${currency(data.downPayment)}`, 60, y0 + 46);
    doc.text(`Balance: ${currency(data.balanceDue)}`, 60, y0 + 62);

    // Refund policy
    if (data.refundPolicyNote || typeof data.refundAgreement !== 'undefined') {
      doc.moveDown(2);
      doc.fontSize(12).fillColor('#111').text('Refund Policy');
      doc.fontSize(10).fillColor('#333');
      if (data.refundPolicyNote) doc.text(data.refundPolicyNote, { width: 495 });
      doc.text(`Acknowledged by customer: ${data.refundAgreement ? 'Yes' : 'No'}`);
    }

    // Footer
    doc.moveDown(1.5);
    doc.fillColor('#777').fontSize(9).text(
      'Thank you for using SecureEscrow. Funds are held securely until both sides confirm.',
      { align: 'center' }
    );

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

/* ---------- submit endpoint ---------- */
app.post('/submit', async (req, res) => {
  try {
    const raw = req.body || {};

    // Normalize + derived
    const amount        = Math.max(0, Number(raw.amount || 0));
    const packageName   = (raw.packageName || '').toString();
    const packagePrice  = Math.max(0, Number(raw.packagePrice || 0));
    const platform      = (raw.platform || '').toString();

    const paymentPlan   = (raw.paymentPlan || 'full').toLowerCase();   // full | milestone
    const downType      = (raw.downType || 'percent').toLowerCase();   // percent | amount
    const downValue     = Number(raw.downValue || 0);
    const milestoneNotes= (raw.milestoneNotes || '').toString();

    const refundAgreement = !!raw.refundAgreement || raw.refundAgreement === 'on';
    const refundPolicyNote= (raw.refundPolicyNote || '').toString().trim();

    // Down payment calc
    let downPayment = 0;
    if (paymentPlan === 'milestone') {
      if (downType === 'percent') {
        const pct = Math.min(100, Math.max(0, downValue));
        downPayment = +(amount * (pct / 100)).toFixed(2);
      } else {
        downPayment = Math.max(0, Math.min(amount, downValue));
      }
    }
    const balanceDue = +(amount - downPayment).toFixed(2);

    const data = {
      invoiceNo: `INV-${stamp()}`,
      createdAt: new Date().toISOString(),

      role: raw.role || '',
      firstName: raw.firstName || '',
      lastName: raw.lastName || '',
      email: raw.email || '',
      phone: raw.phone || '',
      platform,

      packageName,
      packagePrice,

      itemDetails: raw.itemDetails || '',
      amount,
      paymentMethod: raw.paymentMethod || '',

      paymentPlan,
      downType,
      downValue,
      milestoneNotes,
      downPayment,
      balanceDue,

      refundAgreement,
      refundPolicyNote
    };

    // Save JSON
    const jsonPath = path.join(SAVE_FOLDER, `${data.invoiceNo}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));

    // Create PDF
    const pdfPath = path.join(SAVE_FOLDER, `${data.invoiceNo}.pdf`);
    await createInvoicePDF(data, pdfPath);

    // Email customer + you (optional)
    if (transporter) {
      const attachments = fs.existsSync(pdfPath)
        ? [{ filename: `${data.invoiceNo}.pdf`, path: pdfPath }]
        : [];

      // customer
      if (data.email) {
        await transporter.sendMail({
          from: `"SecureEscrow" <${COMPANY_EMAIL}>`,
          to: data.email,
          subject: `Invoice ${data.invoiceNo} • SecureEscrow`,
          text:
`Hi ${data.firstName || ''},

Thanks for your escrow request. Your invoice is attached.

Invoice: ${data.invoiceNo}
Platform: ${data.platform || '-'}
Package : ${data.packageName || '-'} (${currency(data.packagePrice || 0)})
Amount  : ${currency(data.amount)}
Plan    : ${data.paymentPlan === 'milestone' ? 'Milestone / Down payment' : 'Full payment'}
Down    : ${currency(data.downPayment)}
Balance : ${currency(data.balanceDue)}

Refund policy acknowledged: ${data.refundAgreement ? 'Yes' : 'No'}

We’ll follow up with payment instructions based on your selected method: ${data.paymentMethod || '-'}.

— SecureEscrow`,
          attachments
        });
      }

      // you
      await transporter.sendMail({
        from: `"SecureEscrow" <${COMPANY_EMAIL}>`,
        to: COMPANY_EMAIL,
        subject: `New Escrow Request ${data.invoiceNo} — ${data.firstName || ''} ${data.lastName || ''}`,
        text: JSON.stringify(data, null, 2),
        attachments
      });
    }

    res.json({ ok: true, invoiceNo: data.invoiceNo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Failed to save or email invoice' });
  }
});

/* ---------- health + SPA fallback ---------- */
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`SecureEscrow server running at http://localhost:${PORT}`);
});
