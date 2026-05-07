const fs = require('fs');
const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const Stripe = require('stripe');

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

const dataDir = path.join(__dirname, 'data');
const ordersPath = path.join(dataDir, 'orders.json');

function ensureOrdersFile() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(ordersPath)) fs.writeFileSync(ordersPath, '[]', 'utf8');
}

function readOrders() {
  ensureOrdersFile();
  const raw = fs.readFileSync(ordersPath, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeOrders(orders) {
  ensureOrdersFile();
  fs.writeFileSync(ordersPath, JSON.stringify(orders, null, 2), 'utf8');
}

function appendOrder(order) {
  const orders = readOrders();
  orders.unshift(order);
  writeOrders(orders);
}

app.post('/stripe-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    return res.status(400).send('Stripe webhook not configured');
  }

  const signature = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const intent = event.data.object;
    const existing = readOrders();
    const idx = existing.findIndex((o) => o.paymentIntentId === intent.id);
    if (idx >= 0) {
      existing[idx] = {
        ...existing[idx],
        status: 'paid',
        updatedAt: new Date().toISOString(),
      };
      writeOrders(existing);
    }
  }

  res.json({ received: true });
});

app.use(express.json({ limit: '15mb' }));
app.use(express.static(__dirname));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/create-payment-intent', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Stripe secret key is not configured on the server.' });
  }

  const amount = Number(req.body?.amount);
  const currency = String(req.body?.currency || 'usd').toLowerCase();
  const receiptEmail = typeof req.body?.receipt_email === 'string' ? req.body.receipt_email.trim() : '';

  if (!Number.isInteger(amount) || amount < 50) {
    return res.status(400).json({ error: 'Invalid amount. Minimum is $0.50.' });
  }

  try {
    const intent = await stripe.paymentIntents.create({
      amount,
      currency,
      automatic_payment_methods: { enabled: true },
      ...(receiptEmail ? { receipt_email: receiptEmail } : {}),
    });

    res.json({ clientSecret: intent.client_secret, paymentIntentId: intent.id });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to create payment intent.' });
  }
});

app.post('/api/orders', (req, res) => {
  const payload = req.body || {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  const total = Number(payload.total || 0);

  if (!items.length || total <= 0) {
    return res.status(400).json({ error: 'Order must include at least one item and a positive total.' });
  }

  const order = {
    id: `ord_${Date.now()}`,
    status: payload.paymentIntentId ? 'paid' : 'pending',
    source: payload.source || 'stripe',
    paymentIntentId: payload.paymentIntentId || '',
    customer: {
      name: payload.customer?.name || '',
      email: payload.customer?.email || '',
    },
    items,
    total,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  appendOrder(order);
  res.status(201).json({ ok: true, orderId: order.id });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server running at http://localhost:${PORT}`);
});
