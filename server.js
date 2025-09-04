// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');

const app = express();

// ---------- config ----------
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const FROM_EMAIL = process.env.FROM_EMAIL || 'SecureEscrow <no-reply@example.com>';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';

// ---------- middleware ----------
app.use(cors({ origin: true })); // allow file:// and any origin
app.use(express.json({ limit: '1mb' }));
app.use('/static', express.static(path.join(__dirname, 'static'))); // optional for assets

// ---------- helpers ----------
async function ensureDataFile() {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    if (!fs.existsSync(ORDERS_FILE)) {
      await fsp.writeFile(ORDERS_FILE, JSON.stringify({ orders: [] }, null, 2));
    }
  } catch (e) {
    console.error('Failed ensuring data dir/file', e);
  }
}

async function loadOrders() {
  await ensureDataFile();
  const raw = await fsp.readFile(ORDERS_FILE, 'utf8');
  return JSON.parse(raw);
}
async function saveOrders(data) {
  await ensureDataFile();
  await fsp.writeFile(ORDERS_FILE, JSON.stringify(data, null, 2));
}

function genOrderId() {
  // short, copyable e.g., QJM-482193
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const D = '0123456789';
  let a=''; for (let i=0;i<3;i++) a += L[Math.floor(Math.random()*L.length)];
  let b=''; for (let i=0;i<6;i++) b += D[Math.floor(Math.random()*D.length)];
  return `${a}-${b}`;
}

function money(n){ return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(n||0)); }

// ---------- mail transporter ----------
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465, // true for 465, false for 587/25
  auth: { user: SMTP_USER, pass: SMTP_PASS }
});

// simple HTML layout for emails
function emailLayout(title, bodyHtml) {
  return `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Inter,Arial,sans-serif;line-height:1.4;color:#0f172a">
    <h2 style="margin:0 0 10px;color:#0a4e86">${title}</h2>
    <div>${bodyHtml}</div>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0"/>
    <div style="font-size:12px;color:#64748b">SecureEscrow (U.S.) • Bank-grade encryption • Dispute support</div>
  </div>`;
}

async function sendAdminNewOrderEmail(order) {
  const subject = `New Order ${order.orderId} — ${order.role} via ${order.source}`;
  const invoiceUrl = `${BASE_URL}/invoices/${order.orderId}?t=${order.releaseToken}`;
  const html = emailLayout('New order received', `
    <p><b>Order ID:</b> ${order.orderId}</p>
    <p><b>Name:</b> ${order.firstName} ${order.lastName}<br/>
       <b>Email:</b> ${order.email}<br/>
       <b>Phone:</b> ${order.phone}</p>
    <p><b>Role:</b> ${order.role} &bull; <b>Source:</b> ${order.source}</p>
    <p><b>Item/Service:</b> ${order.itemDetails || '(none)'}<br/>
       <b>Status:</b> ${order.status}</p>
    <p><a href="${invoiceUrl}">Open invoice</a></p>
  `);
  await transporter.sendMail({ from: FROM_EMAIL, to: ADMIN_EMAIL, subject, html });
}

async function sendBuyerInvoiceEmail(order) {
  const subject = `Your SecureEscrow Invoice — ${order.orderId}`;
  const invoiceUrl = `${BASE_URL}/invoices/${order.orderId}?t=${order.releaseToken}`;
  const html = emailLayout('Your invoice is ready', `
    <p>Hi ${order.firstName},</p>
    <p>Your escrow request has been created. Use the <b>Order ID</b> as the payment reference when you send funds.</p>
    <p><b>Order ID:</b> ${order.orderId}<br/>
       <b>Role:</b> ${order.role} &bull; <b>Source:</b> ${order.source}</p>
    <p><b>Item/Service:</b> ${order.itemDetails || '(none)'}</p>
    <p><a href="${invoiceUrl}">View invoice</a></p>
    <p><i>Note:</i> Funds are held securely and <u>you control the release</u> once you are satisfied with delivery.</p>
  `);
  await transporter.sendMail({ from: FROM_EMAIL, to: order.email, subject, html });
}

async function sendPaymentConfirmedEmail(order) {
  const subject = `Payment received — ${order.orderId}`;
  const html = emailLayout('Payment received', `
    <p>Payment has been confirmed for <b>${order.orderId}</b>.</p>
    <p>Status is now: <b>${order.status}</b></p>
    <p>Buyer may release funds at any time using the invoice page link.</p>
  `);
  // notify admin and buyer
  await transporter.sendMail({ from: FROM_EMAIL, to: ADMIN_EMAIL, subject, html });
  await transporter.sendMail({ from: FROM_EMAIL, to: order.email, subject, html });
}

async function sendReleasedEmail(order) {
  const subject = `Funds released — ${order.orderId}`;
  const html = emailLayout('Funds released', `
    <p>Funds have been released for <b>${order.orderId}</b>.</p>
    <p>Status is now: <b>${order.status}</b></p>
  `);
  await transporter.sendMail({ from: FROM_EMAIL, to: ADMIN_EMAIL, subject, html });
  await transporter.sendMail({ from: FROM_EMAIL, to: order.email, subject, html });
}

// ---------- routes ----------

// health
app.get('/health', (req,res)=> res.json({ ok:true }));

// Create order + send emails
app.post('/submit', async (req, res) => {
  try {
    const b = req.body || {};
    const required = ['role','source','firstName','lastName','email','phone'];
    for (const k of required) {
      if (!b[k] || String(b[k]).trim()==='') {
        return res.status(400).json({ ok:false, error:`Missing field: ${k}` });
      }
    }
    const orderId = genOrderId();
    const releaseToken = uuidv4(); // used for buyer-controlled release link

    const order = {
      orderId,
      releaseToken,
      createdAt: new Date().toISOString(),
      role: b.role,
      source: b.source,
      firstName: b.firstName,
      lastName: b.lastName,
      email: b.email,
      phone: b.phone,
      itemDetails: b.itemDetails || '',
      deliveryNotes: b.deliveryNotes || '',
      status: 'Awaiting buyer payment',
      escrowBalance: 0
    };

    const data = await loadOrders();
    data.orders.unshift(order);
    await saveOrders(data);

    // emails
    await Promise.all([
      sendAdminNewOrderEmail(order),
      sendBuyerInvoiceEmail(order)
    ]);

    return res.json({
      ok:true,
      orderId,
      invoiceUrl: `${BASE_URL}/invoices/${orderId}?t=${releaseToken}`
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok:false, error:'Server error' });
  }
});

// Simple HTML invoice page
app.get('/invoices/:orderId', async (req,res) => {
  try {
    const { orderId } = req.params;
    const t = req.query.t; // release token (for release action)
    const data = await loadOrders();
    const order = data.orders.find(o => o.orderId === orderId);
    if (!order) return res.status(404).send('Invoice not found');

    const balanceText = order.escrowBalance > 0 ? `${money(order.escrowBalance)} (held)` : '$0.00 (pending)';
    const releaseButton = order.status.startsWith('Buyer paid')
      ? `<form method="POST" action="/payments/${order.orderId}/release?t=${encodeURIComponent(t||'')}">
           <button style="padding:10px 14px;border-radius:10px;border:1px solid #0ea371;background:#10b981;color:#fff;font-weight:800;cursor:pointer">Release funds</button>
         </form>`
      : `<div style="color:#64748b">Funds can be released after payment is confirmed.</div>`;

    res.setHeader('Content-Type','text/html');
    res.send(`
<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>Invoice ${order.orderId} — SecureEscrow</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
</head>
<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Inter,Arial,sans-serif;background:#f8fafc;margin:0">
  <div style="max-width:720px;margin:20px auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 10px 26px rgba(2,8,20,.12);">
    <div style="padding:18px 16px;border-bottom:1px solid #e5e7eb;color:#0b3a91;font-weight:800">SecureEscrow — Invoice</div>
    <div style="padding:16px">
      <h2 style="margin:6px 0;color:#153a8a">Order ${order.orderId}</h2>
      <p><b>Name:</b> ${order.firstName} ${order.lastName}<br/>
         <b>Email:</b> ${order.email} • <b>Phone:</b> ${order.phone}</p>
      <p><b>Role:</b> ${order.role} • <b>Source:</b> ${order.source}</p>
      <p><b>Item/Service:</b> ${order.itemDetails || '(none)'}<br/>
         <b>Delivery notes:</b> ${order.deliveryNotes || '(none)'}</p>
      <p><b>Status:</b> ${order.status}<br/>
         <b>Available escrow balance:</b> ${balanceText}</p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0"/>
      <h3>How to pay</h3>
      <ol>
        <li>Send funds using your agreed method. Use <b>Order ID ${order.orderId}</b> as the payment reference.</li>
        <li>Email your receipt/confirmation to ${ADMIN_EMAIL} (or reply to your invoice email).</li>
      </ol>
      <div style="margin-top:16px">${releaseButton}</div>
      <p style="margin-top:16px;color:#64748b">Buyer-controlled release • United States escrow • Bank-grade encryption</p>
    </div>
  </div>
</body>
</html>`);
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error');
  }
});

// Mark payment confirmed (admin action)
app.post('/payments/:orderId/confirm', async (req,res)=>{
  try{
    const { orderId } = req.params;
    const data = await loadOrders();
    const idx = data.orders.findIndex(o => o.orderId === orderId);
    if (idx === -1) return res.status(404).json({ ok:false, error:'Order not found' });
    const order = data.orders[idx];

    order.status = 'Buyer paid — awaiting buyer release';
    order.escrowBalance = order.escrowBalance || 0; // you can set a number here if you track amounts later
    order.paidAt = new Date().toISOString();

    await saveOrders(data);
    await sendPaymentConfirmedEmail(order);
    return res.json({ ok:true, order });
  }catch(e){
    console.error(e);
    return res.status(500).json({ ok:false, error:'Server error' });
  }
});

// Buyer releases funds (requires token from email/invoice link)
app.post('/payments/:orderId/release', async (req,res)=>{
  try{
    const { orderId } = req.params;
    const t = req.query.t;
    const data = await loadOrders();
    const idx = data.orders.findIndex(o => o.orderId === orderId);
    if (idx === -1) return res.status(404).send('Order not found');

    const order = data.orders[idx];
    if (!t || t !== order.releaseToken) {
      return res.status(403).send('Invalid or missing release token');
    }
    if (!order.status.startsWith('Buyer paid')) {
      return res.status(400).send('Payment not confirmed yet');
    }

    order.status = 'Funds released to seller';
    order.releasedAt = new Date().toISOString();
    await saveOrders(data);
    await sendReleasedEmail(order);

    // after release, show a small confirmation page
    res.setHeader('Content-Type','text/html');
    res.send(`
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Inter,Arial,sans-serif;padding:20px">
        <h2>Funds released</h2>
        <p>Order <b>${order.orderId}</b> marked as released. Thank you.</p>
        <p><a href="${BASE_URL}/invoices/${order.orderId}?t=${encodeURIComponent(order.releaseToken)}">Back to invoice</a></p>
      </div>
    `);
  }catch(e){
    console.error(e);
    res.status(500).send('Server error');
  }
});

app.listen(PORT, async () => {
  await ensureDataFile();
  console.log(`SecureEscrow backend running on ${BASE_URL}`);
});
