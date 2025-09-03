// server.js  (CommonJS)
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
const COMPANY_EMAIL   = process.env.COMPANY_EMAIL   || "escrowservicecopyright@gmail.com";
const EMAIL_PASSWORD  = process.env.EMAIL_PASSWORD  || process.env.EMAIL_PASS || "";
let transporter = null;

if (EMAIL_PASSWORD) {
  transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: COMPANY_EMAIL, pass: EMAIL_PASSWORD }
  });
}

/* ---------- tiny helpers ---------- */
const currency = (n) => {
  const num = Number(n || 0);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num);
};
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
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
    doc
      .fillColor('#0b3a91')
      .fontSize(20)
      .text('SecureEscrow', 120, 50)
      .moveDown();

    doc
      .fillColor('#111')
      .fontSize(16)
      .text('INVOICE', 50, 120);

    // Meta
    doc.fontSize(10).fillColor('#333');
    doc.text(`Invoice #: ${data.invoiceNo}`, 50, 145);
    doc.text(`Date: ${today()}`, 50, 160);
    doc.text(`Client: ${data.firstName} ${data.lastName}`, 50, 175);
    doc.text(`Email: ${data.email}`, 50, 190);
    doc.text(`Phone: ${data.phone}`, 50, 205);

    // Divider
    doc.moveTo(50, 220).lineTo(545, 220).strokeColor('#ddd').stroke();

    // Details
    doc.fillColor('#111').fontSize(12).text('Summary', 50, 240);
    doc.fontSize(10).fillColor('#333');
    doc.text(`Role: ${data.role || '-'}`, 50, 260);
    doc.text(`Platform: ${data.platform || '-'}`, 50, 275);
    doc.text(`Package: ${data.packageName || '-'} (${currency(data.packagePrice || 0)})`, 50, 290);
    doc.text(`Payment Plan: ${data.paymentPlan}`, 50, 305);

    if (data.paymentPlan === 'milestone') {
      doc.text(
        `Down Payment: ${data.downType === 'percent' ? data.downValue + '%' : currency(data.downValue)}  ` +
        `${data.milestoneNotes ? ' | Notes: ' + data.milestoneNotes : ''}`,
        50, 320
      );
    }

    doc.text(`Payment Method: ${data.paymentMethod}`, 50, 335);

    // Item / service
    const desc = (data.itemDetails || '').trim() || '—';
    doc.fillColor('#111').fontSize(12).text('Item / Service', 50, 360);
    doc.fontSize(10).fillColor('#333').text(desc, 50, 378, { width: 495 });

    // Amounts box
    const y0 = doc.y + 16;
    const subtotal = Number(data.amount || 0);
    let downDue = 0;
    if (data.paymentPlan === 'milestone' && data.downValue) {
      downDue = data.downType === 'percent'
        ? Math.round((subtotal * Number(data.downValue)) / 100)
        : Number(data.downValue);
    }
    const balance = Math.max(0, subtotal - downDue);

    doc.roundedRect(50, y0, 495, 110, 6).strokeColor('#ddd').stroke();
    doc.fontSize(11).fillColor('#111');
    doc.text('Totals', 60, y0 + 10);
    doc.fontSize(10).fillColor('#333');
    doc.text(`Subtotal: ${currency(subtotal)}`, 60, y0 + 30);
    if (downDue > 0) doc.text(`Down Payment Due Now: ${currency(downDue)}`, 60, y0 + 46);
    doc.text(`Balance: ${currency(balance)}`, 60, y0 + 62);

    // Footer
    doc.fillColor('#777').fontSize(9);
    doc.text('Thank you for using SecureEscrow. Funds are held securely until both sides confirm.', 50, y0 + 100, { width: 495, align: 'center' });

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

/* ---------- form endpoint ---------- */
app.post('/submit', async (req, res) => {
  try {
    const data = req.body || {};

    // Derive invoice number and ensure amount is numeric
    data.invoiceNo = `INV-${stamp()}`;
    data.amount = Number(data.amount || 0);

    // Save raw JSON
    const jsonPath = path.join(SAVE_FOLDER, `${data.invoiceNo}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));

    // Build PDF invoice
    const pdfPath = path.join(SAVE_FOLDER, `${data.invoiceNo}.pdf`);
    await createInvoicePDF(data, pdfPath);

    // Email (to customer + to you) if transporter configured
    if (transporter) {
      const attachments = [];
      if (fs.existsSync(pdfPath)) attachments.push({ filename: `${data.invoiceNo}.pdf`, path: pdfPath });

      // to customer
      if (data.email) {
        await transporter.sendMail({
          from: `"SecureEscrow" <${COMPANY_EMAIL}>`,
          to: data.email,
          subject: `Invoice ${data.invoiceNo} — SecureEscrow`,
          text:
`Hi ${data.firstName || ''},

Thanks! We’ve received your escrow request.

Invoice: ${data.invoiceNo}
Amount: ${currency(data.amount)}
Package: ${data.packageName || '-'} (${currency(data.packagePrice || 0)})
Platform: ${data.platform || '-'}

We’ll follow up shortly with payment instructions based on your selected method: ${data.paymentMethod}.
(Your PDF invoice is attached.)

– SecureEscrow`,
          attachments
        });
      }

      // to you (with JSON attached)
      await transporter.sendMail({
        from: `"SecureEscrow" <${COMPANY_EMAIL}>`,
        to: COMPANY_EMAIL,
        subject: `New Escrow Request ${data.invoiceNo} — ${data.firstName || ''} ${data.lastName || ''}`,
        text: JSON.stringify(data, null, 2),
        attachments
      });
    }

    return res.json({ ok: true, invoiceNo: data.invoiceNo });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ---------- health + SPA fallback ---------- */
app.get('/health', (req, res) => res.json({ ok: true }));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`SecureEscrow server running at http://localhost:${PORT}`);
});
