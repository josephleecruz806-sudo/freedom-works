const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const dotenv = require('dotenv');
const Stripe = require('stripe');

let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (_) {
  nodemailer = null;
}

let sharp = null;
try {
  sharp = require('sharp');
  // Render's free plan only has 512MB RAM. Decoding a single 20MB+ print PNG
  // can briefly use hundreds of MB, so cap libvips to one operation at a time
  // and shrink its internal cache instead of letting it run wide-open and
  // risk an out-of-memory crash of the whole process.
  sharp.concurrency(1);
  sharp.cache({ memory: 32, files: 0, items: 50 });
} catch (_) {
  sharp = null;
}

dotenv.config();

const app = express();
const BOOT_ID = crypto.randomBytes(4).toString('hex');
const PORT = Number(process.env.PORT || 3000);
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PUBLISHABLE_KEY = String(process.env.STRIPE_PUBLISHABLE_KEY || '').trim();
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || 'freedom-works-local-auth-secret';
const OWNER_EMAIL = normalizeEmail(process.env.OWNER_EMAIL || 'owner@freedomworks.local');
const OWNER_PASSWORD = String(process.env.OWNER_PASSWORD || 'ChangeMe123!');
const OWNER_NOTIFY_EMAIL = normalizeEmail(process.env.OWNER_NOTIFY_EMAIL || OWNER_EMAIL || 'josephleecruz806@gmail.com');
const SMTP_HOST = String(process.env.SMTP_HOST || '').trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE = String(process.env.SMTP_SECURE || (SMTP_PORT === 465 ? 'true' : 'false')).toLowerCase() === 'true';
const SMTP_USER = String(process.env.SMTP_USER || '').trim();
const SMTP_PASS = String(process.env.SMTP_PASS || '').trim();
const SMTP_FROM = String(process.env.SMTP_FROM || SMTP_USER || OWNER_NOTIFY_EMAIL).trim();
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const UPSTASH_REDIS_REST_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
const UPSTASH_REDIS_REST_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();

const dataDir = path.join(__dirname, 'data');
const ordersPath = path.join(dataDir, 'orders.json');
const customersPath = path.join(dataDir, 'customers.json');
const inventoryPath = path.join(dataDir, 'inventory.json');
const designSalesPath = path.join(dataDir, 'design-sales.json');
const designNamesPath = path.join(dataDir, 'design-names.json');
let emailTransport = null;
const BASE_DESIGN_PRICE = 24.99;
const DESIGN_SALE_SIZES = new Set([
  'Newborn', '6M', '9M', '12M', '18M', '18-24M',
  '2T', '3T', '4T', '5T',
  'Youth S', 'Youth M', 'Youth L', 'Youth XL',
  'Adult S', 'Adult M', 'Adult L', 'Adult XL',
  '2X', '3X',
]);
const INVENTORY_SIZES = new Set([
  'Newborn', '6M', '9M', '12M', '18M', '18-24M',
  '2T', '3T', '4T', '5T',
  'Youth S', 'Youth M', 'Youth L', 'Youth XL',
  'Adult S', 'Adult M', 'Adult L', 'Adult XL',
  '2X', '3X',
]);
const REWARDS_POINTS_PER_SHIRT = 1;
const REWARDS_POINTS_STEP = 10;
const REWARDS_REWARD_STEP_DOLLARS = 5;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif']);

function setNoCacheHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
}

function setImageCacheHeaders(res) {
  // Design images rarely change once uploaded, so let browsers cache them for a
  // week instead of re-downloading every single design on every page load.
  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.removeHeader('Pragma');
  res.removeHeader('Expires');
  res.removeHeader('Surrogate-Control');
}

function buildImageIndex() {
  const entries = fs.readdirSync(__dirname, { withFileTypes: true });
  const map = new Map();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) continue;
    map.set(entry.name.toLowerCase(), entry.name);
  }
  return map;
}

let imageIndex = buildImageIndex();

function getImageIndex() {
  imageIndex = buildImageIndex();
  return imageIndex;
}

function getDesignCatalogFiles() {
  return Array.from(getImageIndex().values())
    .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
}

function ensureDataFiles() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(ordersPath)) fs.writeFileSync(ordersPath, '[]', 'utf8');
  if (!fs.existsSync(customersPath)) fs.writeFileSync(customersPath, '[]', 'utf8');
  if (!fs.existsSync(inventoryPath)) fs.writeFileSync(inventoryPath, '[]', 'utf8');
  if (!fs.existsSync(designSalesPath)) fs.writeFileSync(designSalesPath, '[]', 'utf8');
  if (!fs.existsSync(designNamesPath)) fs.writeFileSync(designNamesPath, '[]', 'utf8');
}

// --- Upstash Redis-backed durability layer ------------------------------
// Render's free web-service disk is ephemeral (wiped on every deploy/restart),
// so data/*.json (customers, orders, inventory, design-sales) cannot be the
// permanent source of truth in production. When UPSTASH_REDIS_REST_URL /
// UPSTASH_REDIS_REST_TOKEN are configured, we mirror every write to a matching
// Redis key (whole array stored as one JSON string), and hydrate the local
// JSON files from Redis once at server startup (before accepting requests).
// If those env vars are not set (e.g. local development), everything behaves
// exactly as before: pure local-file storage, no network calls. Upstash's
// free tier (upstash.com) is $0/month forever with no credit card required.
const REDIS_KEY_BY_PATH = new Map([
  [ordersPath, 'freedom_works:orders'],
  [customersPath, 'freedom_works:customers'],
  [inventoryPath, 'freedom_works:inventory'],
  [designSalesPath, 'freedom_works:design_sales'],
  [designNamesPath, 'freedom_works:design_names'],
]);

function isRedisConfigured() {
  return Boolean(UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN);
}

async function redisCommand(commandArray) {
  if (!isRedisConfigured()) return null;
  // Bound each call so a stalled Upstash connection can't hang the request
  // forever - callers need a timely yes/no to decide whether to retry.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(UPSTASH_REDIS_REST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commandArray),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Upstash request failed: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    return data.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function pullAllCollectionsToDisk() {
  if (!isRedisConfigured()) return;
  for (const [filePath, key] of REDIS_KEY_BY_PATH) {
    try {
      const raw = await redisCommand(['GET', key]);
      if (typeof raw === 'string' && raw.length) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) {
          fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), 'utf8');
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`Upstash hydrate failed for ${key}:`, err.message || err);
    }
  }
}

async function pushRecordsToRedis(filePath, records) {
  // No Redis configured (e.g. local dev) means the local file IS the source
  // of truth, so there is nothing to fail - report success.
  if (!isRedisConfigured()) return true;
  const key = REDIS_KEY_BY_PATH.get(filePath);
  if (!key) return true;
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await redisCommand(['SET', key, JSON.stringify(records || [])]);
      return true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`Upstash sync failed for ${key} (attempt ${attempt}/${maxAttempts}):`, err.message || err);
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 400));
      }
    }
  }
  return false;
}
// -------------------------------------------------------------------------

function readArrayFile(filePath) {
  ensureDataFiles();
  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeArrayFile(filePath, records) {
  ensureDataFiles();
  fs.writeFileSync(filePath, JSON.stringify(records, null, 2), 'utf8');
  // Awaited (not fire-and-forget) so the Redis copy is durable before the
  // HTTP response goes out - otherwise a redeploy that kills this process
  // moments later can lose the write entirely (disk is wiped, Redis never
  // got it), silently dropping the record that was just created. Returns
  // whether the Redis copy actually succeeded so callers can react.
  return pushRecordsToRedis(filePath, records);
}

function readOrders() {
  return readArrayFile(ordersPath);
}

async function writeOrders(orders) {
  return writeArrayFile(ordersPath, orders);
}

async function appendOrder(order) {
  const orders = readOrders();
  orders.unshift(order);
  return writeOrders(orders);
}

function getEmailTransport() {
  if (emailTransport) return emailTransport;
  if (!nodemailer || !SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;

  emailTransport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });

  return emailTransport;
}

function readCustomers() {
  return readArrayFile(customersPath);
}

async function writeCustomers(customers) {
  return writeArrayFile(customersPath, customers);
}

function readInventory() {
  return readArrayFile(inventoryPath);
}

async function writeInventory(records) {
  return writeArrayFile(inventoryPath, records);
}

function readDesignSales() {
  return readArrayFile(designSalesPath);
}

async function writeDesignSales(records) {
  return writeArrayFile(designSalesPath, records);
}

function readDesignNames() {
  return readArrayFile(designNamesPath);
}

async function writeDesignNames(records) {
  return writeArrayFile(designNamesPath, records);
}

function getDesignNameMap() {
  const map = new Map();
  readDesignNames().forEach((record) => {
    const key = normalizeDesignFileName(record?.src || '').toLowerCase();
    const name = normalizeTextField(record?.name || '', 80);
    if (key && name) map.set(key, name);
  });
  return map;
}

function getSanitizedDesignNames() {
  const map = getDesignNameMap();
  return Object.fromEntries(map.entries());
}

function normalizeDesignFileName(value) {
  const rawValue = typeof value === 'object' && value !== null
    ? (value.src || value.value || value.name || '')
    : value;
  const trimmed = String(rawValue || '').trim();
  if (!trimmed) return '';

  const withoutQuery = trimmed.split('?')[0].split('#')[0];
  const basename = path.basename(withoutQuery);
  const candidates = Array.from(new Set([
    trimmed,
    withoutQuery,
    basename,
    (() => {
      try {
        return decodeURIComponent(trimmed);
      } catch (_) {
        return '';
      }
    })(),
    (() => {
      try {
        return decodeURIComponent(withoutQuery);
      } catch (_) {
        return '';
      }
    })(),
    (() => {
      try {
        return decodeURIComponent(basename);
      } catch (_) {
        return '';
      }
    })(),
  ].filter(Boolean).map((entry) => String(entry).trim())));

  const imageIndex = getImageIndex();
  for (const candidate of candidates) {
    const requested = path.basename(candidate);
    const match = imageIndex.get(requested.toLowerCase());
    if (match) return match;
  }
  return '';
}

function normalizeDesignSaleOfferType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'bundle') return 'bundle';
  if (normalized === 'percentage') return 'percentage';
  return 'single';
}

function normalizeDesignSaleSizes(values) {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values
    .map((value) => String(value || '').trim())
    .filter((value) => DESIGN_SALE_SIZES.has(value))));
}

function getDesignSaleOfferDetails(record) {
  const offerType = normalizeDesignSaleOfferType(record?.offerType || (record?.bundleQuantity ? 'bundle' : 'single'));

  if (offerType === 'bundle') {
    const bundleQuantity = Math.max(0, Math.round(Number(record?.bundleQuantity || 0)));
    const bundlePrice = Number(record?.bundlePrice || 0);
    if (bundleQuantity < 2) return null;
    if (!Number.isFinite(bundlePrice) || bundlePrice < 0) return null;
    if (bundlePrice >= (BASE_DESIGN_PRICE * bundleQuantity)) return null;
    return {
      offerType,
      salePrice: 0,
      salePercent: 0,
      bundleQuantity,
      bundlePrice: Number(bundlePrice.toFixed(2)),
    };
  }

  if (offerType === 'percentage') {
    const salePercent = Number(record?.salePercent || 0);
    if (!Number.isFinite(salePercent) || salePercent <= 0 || salePercent >= 100) return null;
    const salePrice = Number((BASE_DESIGN_PRICE * ((100 - salePercent) / 100)).toFixed(2));
    if (salePrice < 0 || salePrice >= BASE_DESIGN_PRICE) return null;
    return {
      offerType,
      salePrice,
      salePercent: Number(salePercent.toFixed(2)),
      bundleQuantity: 0,
      bundlePrice: 0,
    };
  }

  const salePrice = Number(record?.salePrice || 0);
  if (!Number.isFinite(salePrice) || salePrice < 0) return null;
  if (salePrice >= BASE_DESIGN_PRICE) return null;
  return {
    offerType: 'single',
    salePrice: Number(salePrice.toFixed(2)),
    salePercent: 0,
    bundleQuantity: 0,
    bundlePrice: 0,
  };
}

function sanitizeDesignSale(record) {
  const sourceFile = normalizeDesignFileName(record?.src || '');
  const endsAt = new Date(record?.endsAt || 0);
  const startsAt = new Date(record?.startsAt || 0);
  const now = Date.now();
  const offer = getDesignSaleOfferDetails(record);
  const offerType = offer?.offerType || 'single';
  const offerGroupId = String(record?.offerGroupId || '').trim() || (offerType === 'bundle'
    ? ['bundle', String(record?.startsAt || ''), String(record?.endsAt || ''), Number(offer?.bundleQuantity || 0), Number(offer?.bundlePrice || 0), normalizeDesignSaleSizes(record?.shirtSizes).join(',')].join('|')
    : '');
  const endsAtValue = Number.isNaN(endsAt.getTime()) ? '' : endsAt.toISOString();
  const startsAtValue = Number.isNaN(startsAt.getTime()) ? '' : startsAt.toISOString();
  const timeLeftMs = endsAtValue ? Math.max(0, endsAt.getTime() - now) : 0;
  return {
    id: String(record?.id || ''),
    src: sourceFile,
    offerType,
    offerGroupId,
    salePrice: Number(offer?.salePrice || 0),
    salePercent: Number(offer?.salePercent || 0),
    bundleQuantity: Number(offer?.bundleQuantity || 0),
    bundlePrice: Number(offer?.bundlePrice || 0),
    shirtSizes: normalizeDesignSaleSizes(record?.shirtSizes),
    originalPrice: BASE_DESIGN_PRICE,
    startsAt: startsAtValue,
    endsAt: endsAtValue,
    active: Boolean(sourceFile) && Boolean(offer) && timeLeftMs > 0,
    timeLeftMs,
    createdAt: String(record?.createdAt || ''),
    updatedAt: String(record?.updatedAt || ''),
  };
}

function getActiveDesignSales() {
  const now = Date.now();
  const current = readDesignSales();
  const active = current.filter((record) => {
    const sourceFile = normalizeDesignFileName(record?.src || '');
    const endsAt = new Date(record?.endsAt || 0);
    const offer = getDesignSaleOfferDetails(record);
    return Boolean(sourceFile)
      && Boolean(offer)
      && !Number.isNaN(endsAt.getTime())
      && endsAt.getTime() > now;
  }).map((record) => ({
    ...record,
    src: normalizeDesignFileName(record?.src || ''),
    ...getDesignSaleOfferDetails(record),
  }));

  if (active.length !== current.length) {
    writeDesignSales(active);
  }

  return active;
}

function getSanitizedDesignSales() {
  return getActiveDesignSales().map(sanitizeDesignSale);
}

// --- Automatic daily random sale ------------------------------------------
// Every 24 hours, put 10 random designs on sale for the owner with zero
// manual effort. A batch stays active until its 24-hour window expires
// (tracked via each record's own endsAt, same as owner-created sales), at
// which point the next periodic check below generates a fresh batch.
const AUTO_SALE_SOURCE = 'auto-random';
const AUTO_SALE_BATCH_SIZE = 10;
const AUTO_SALE_PERCENT = 20;
const AUTO_SALE_DURATION_MS = 24 * 60 * 60 * 1000;
const AUTO_SALE_CHECK_INTERVAL_MS = 15 * 60 * 1000;

function pickRandomDesigns(files, count) {
  const pool = files.slice();
  const picked = [];
  while (pool.length && picked.length < count) {
    const idx = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(idx, 1)[0]);
  }
  return picked;
}

async function ensureRandomDailySaleBatch() {
  const current = getActiveDesignSales();
  if (current.some((record) => record?.source === AUTO_SALE_SOURCE)) return;

  const catalogFiles = getDesignCatalogFiles();
  if (!catalogFiles.length) return;

  const activeSaleSrcs = new Set(current.map((record) => normalizeDesignFileName(record?.src || '')));
  const availableFiles = catalogFiles.filter((file) => !activeSaleSrcs.has(normalizeDesignFileName(file)));
  const sourcePool = availableFiles.length >= AUTO_SALE_BATCH_SIZE ? availableFiles : catalogFiles;
  const chosen = pickRandomDesigns(sourcePool, AUTO_SALE_BATCH_SIZE);
  if (!chosen.length) return;

  const now = new Date();
  const endsAt = new Date(now.getTime() + AUTO_SALE_DURATION_MS);
  const newBatch = chosen.map((src, index) => ({
    id: `auto_sale_${now.getTime()}_${index}`,
    src,
    source: AUTO_SALE_SOURCE,
    offerType: 'percentage',
    salePercent: AUTO_SALE_PERCENT,
    shirtSizes: [],
    startsAt: now.toISOString(),
    endsAt: endsAt.toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }));

  await writeDesignSales([...newBatch, ...current]);
  // eslint-disable-next-line no-console
  console.log(`Auto random sale: put ${newBatch.length} designs on sale until ${endsAt.toISOString()}.`);
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeTextField(value, maxLength = 160) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeDesignPreview(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const safeLimit = 2000000;
  if (raw.length > safeLimit) return '';
  if (/^data:image\//i.test(raw)) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/')) return raw;
  return '';
}

function sanitizeOrderItem(item) {
  const record = item && typeof item === 'object' ? item : {};
  return {
    name: normalizeTextField(record.name || 'Item', 180),
    type: normalizeTextField(record.type || 'standard', 40),
    shirtSize: normalizeTextField(record.shirtSize || '', 40),
    printLocation: normalizeTextField(record.printLocation || '', 40),
    shirtColorName: normalizeTextField(record.shirtColorName || '', 64),
    shirtColorHex: normalizeTextField(record.shirtColorHex || '', 16).toLowerCase(),
    designType: normalizeTextField(record.designType || '', 40),
    designName: normalizeTextField(record.designName || '', 160),
    designFrontFile: normalizeTextField(record.designFrontFile || '', 220),
    designBackFile: normalizeTextField(record.designBackFile || '', 220),
    designFrontPreview: normalizeDesignPreview(record.designFrontPreview || ''),
    designBackPreview: normalizeDesignPreview(record.designBackPreview || ''),
    catalogDesignSrc: normalizeTextField(record.catalogDesignSrc || '', 220),
    designPreview: normalizeDesignPreview(record.designPreview || ''),
    price: Math.max(0, Number(record.price || 0)),
  };
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildOrderItemsSummary(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  if (!items.length) return 'No items listed';
  return items.map((item, index) => {
    const lines = [`${index + 1}. ${item?.name || 'Item'} - $${Number(item?.price || 0).toFixed(2)}`];
    if (item?.shirtSize) lines.push(`Size: ${item.shirtSize}`);
    if (item?.shirtColorName || item?.shirtColorHex) {
      lines.push(`Shirt Color: ${(item?.shirtColorName || 'Not listed')}${item?.shirtColorHex ? ` (${item.shirtColorHex})` : ''}`);
    }
    if (item?.printLocation) lines.push(`Print Location: ${item.printLocation}`);
    if (item?.designName) lines.push(`Design: ${item.designName}`);
    if (item?.designType) lines.push(`Design Type: ${item.designType}`);
    if (item?.designFrontFile) lines.push(`Front Design File: ${item.designFrontFile}`);
    if (item?.designBackFile) lines.push(`Back Design File: ${item.designBackFile}`);
    if (item?.designFrontPreview) {
      lines.push(`Front Preview: ${/^data:image\//i.test(String(item.designFrontPreview || '')) ? 'embedded in owner HTML email and owner dashboard' : item.designFrontPreview}`);
    }
    if (item?.designBackPreview) {
      lines.push(`Back Preview: ${/^data:image\//i.test(String(item.designBackPreview || '')) ? 'embedded in owner HTML email and owner dashboard' : item.designBackPreview}`);
    }
    if (item?.catalogDesignSrc) lines.push(`Catalog Source: ${item.catalogDesignSrc}`);
    if (item?.designPreview) {
      lines.push(`Preview Image: ${/^data:image\//i.test(String(item.designPreview || '')) ? 'embedded in owner HTML email and owner dashboard' : item.designPreview}`);
    }
    return lines.map((line, lineIndex) => (lineIndex === 0 ? line : `   ${line}`)).join('\n');
  }).join('\n');
}

function resolveOrderItemPreview(item) {
  const rawPreview = String(item?.designPreview || '').trim();
  if (/^data:image\//i.test(rawPreview)) {
    return { type: 'inline', src: rawPreview };
  }
  if (/^https?:\/\//i.test(rawPreview)) {
    return { type: 'inline', src: rawPreview };
  }

  const candidateFile = normalizeDesignFileName(
    item?.catalogDesignSrc
      || item?.designFrontFile
      || item?.designBackFile
      || rawPreview
  );
  if (!candidateFile) {
    if (rawPreview.startsWith('/')) {
      return { type: 'inline', src: rawPreview };
    }
    return null;
  }

  const absolutePath = path.join(__dirname, candidateFile);
  if (!fs.existsSync(absolutePath)) return null;
  const ext = path.extname(candidateFile).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) return null;

  return {
    type: 'attachment',
    fileName: candidateFile,
    absolutePath,
  };
}

function getDataUrlParts(dataUrl) {
  const raw = String(dataUrl || '').trim();
  const match = raw.match(/^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return null;
  const mimeType = String(match[1] || '').toLowerCase();
  const base64Data = String(match[2] || '').replace(/\s+/g, '');
  if (!mimeType || !base64Data) return null;
  return { mimeType, base64Data };
}

const MIME_TYPE_TO_EXTENSION = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
};

function getExtensionForMimeType(mimeType) {
  return MIME_TYPE_TO_EXTENSION[String(mimeType || '').toLowerCase()] || 'png';
}

function sanitizeAttachmentBaseName(name, fallback) {
  const source = String(name || '').trim() || String(fallback || '').trim() || 'upload';
  const withoutExt = source.replace(/\.[^.]+$/, '');
  return withoutExt
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'upload';
}

function buildOwnerPreviewAssets(order) {
  const previewByIndex = new Map();
  const downloadByIndex = new Map();
  const attachments = [];
  const items = Array.isArray(order?.items) ? order.items : [];

  function setPreviewForKey(item, key) {
    const resolved = resolveOrderItemPreview(item);
    if (!resolved) return;
    if (resolved.type === 'inline' && resolved.src) {
      previewByIndex.set(key, resolved.src);
      return;
    }
    if (resolved.type === 'attachment' && resolved.absolutePath) {
      const cid = `order-${String(order?.id || Date.now())}-${key}@freedom-works`;
      attachments.push({
        filename: path.basename(resolved.fileName),
        path: resolved.absolutePath,
        cid,
      });
      previewByIndex.set(key, `cid:${cid}`);
    }
  }

  function setDownloadForKey(rawDataUrl, key, label, suggestedFileName) {
    const dataUrl = getDataUrlParts(rawDataUrl);
    if (!dataUrl) return;
    const ext = getExtensionForMimeType(dataUrl.mimeType);
    const baseName = sanitizeAttachmentBaseName(
      suggestedFileName,
      `order-${String(order?.id || Date.now())}-item-${String(key).replace(/[^0-9]/g, '') || key}-${label}`
    );
    const filename = `${baseName}.${ext}`;
    const cid = `order-${String(order?.id || Date.now())}-${key}-${label}-download@freedom-works`;
    attachments.push({
      filename,
      content: dataUrl.base64Data,
      encoding: 'base64',
      contentType: dataUrl.mimeType,
      cid,
    });
    downloadByIndex.set(`${key}:${label}`, `cid:${cid}`);
  }

  items.forEach((item, idx) => {
    setPreviewForKey({ ...item, designPreview: item?.designFrontPreview || item?.designFrontFile || '' }, `${idx}:front`);
    setPreviewForKey({ ...item, designPreview: item?.designBackPreview || item?.designBackFile || '' }, `${idx}:back`);
    setPreviewForKey(item, `${idx}:main`);
    setDownloadForKey(item?.designFrontPreview || '', String(idx), 'front', item?.designFrontFile || `item-${idx + 1}-front`);
    setDownloadForKey(item?.designBackPreview || '', String(idx), 'back', item?.designBackFile || `item-${idx + 1}-back`);
  });

  return { previewByIndex, downloadByIndex, attachments };
}

function buildOwnerNotificationHtml(order, previewByIndex, downloadByIndex) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const shipping = order?.shipping || {};
  const fulfillmentMethod = String(order?.fulfillmentMethod || shipping?.fulfillmentMethod || 'delivery').toLowerCase() === 'pickup' ? 'pickup' : 'delivery';
  const shippingAmount = Number(order?.shippingAmount || 0);
  const shippingSummary = fulfillmentMethod === 'pickup'
    ? [shipping.fullName || '', shipping.email || ''].filter(Boolean).join(' | ')
    : [
      shipping.fullName || '',
      shipping.addressLine1 || '',
      shipping.addressLine2 || '',
      [shipping.city || '', shipping.state || '', shipping.postalCode || ''].filter(Boolean).join(', '),
      shipping.email || '',
    ].filter(Boolean).join(' | ');

  const itemCards = items.length
    ? items.map((item, idx) => {
      const frontPreview = String(previewByIndex?.get(`${idx}:front`) || item?.designFrontPreview || '');
      const backPreview = String(previewByIndex?.get(`${idx}:back`) || item?.designBackPreview || '');
      const preview = String(previewByIndex?.get(`${idx}:main`) || item?.designPreview || '');
      const previewList = [
        frontPreview,
        backPreview,
        preview,
      ].filter(Boolean).slice(0, 3);
      const frontDownloadLink = String(downloadByIndex?.get(`${idx}:front`) || '').trim();
      const backDownloadLink = String(downloadByIndex?.get(`${idx}:back`) || '').trim();
      const downloadButtons = [
        frontDownloadLink
          ? `<a href="${escapeHtml(frontDownloadLink)}" style="display:inline-block;padding:7px 10px;border-radius:8px;background:#1459d9;color:#ffffff;text-decoration:none;font-size:12px;font-weight:700;">Download Front Upload</a>`
          : '',
        backDownloadLink
          ? `<a href="${escapeHtml(backDownloadLink)}" style="display:inline-block;padding:7px 10px;border-radius:8px;background:#1459d9;color:#ffffff;text-decoration:none;font-size:12px;font-weight:700;">Download Back Upload</a>`
          : '',
      ].filter(Boolean).join(' ');
      const details = [
        item?.shirtSize ? `Size: ${item.shirtSize}` : '',
        (item?.shirtColorName || item?.shirtColorHex)
          ? `Shirt Color: ${item?.shirtColorName || 'Not listed'}${item?.shirtColorHex ? ` (${item.shirtColorHex})` : ''}`
          : '',
        item?.printLocation ? `Print Location: ${item.printLocation}` : '',
        item?.designName ? `Design: ${item.designName}` : '',
        item?.designType ? `Design Type: ${item.designType}` : '',
        item?.designFrontFile ? `Front File: ${item.designFrontFile}` : '',
        item?.designBackFile ? `Back File: ${item.designBackFile}` : '',
        item?.catalogDesignSrc ? `Catalog Source: ${item.catalogDesignSrc}` : '',
      ].filter(Boolean);

      return `<div style="border:1px solid #d8e2f2;border-radius:12px;padding:12px;margin-bottom:10px;">
        <div style="font-weight:700;margin-bottom:6px;">${idx + 1}. ${escapeHtml(item?.name || 'Item')} - $${Number(item?.price || 0).toFixed(2)}</div>
        ${previewList.length ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0;">${previewList.map((src, imageIndex) => `<div style="display:flex;flex-direction:column;gap:4px;"><img src="${escapeHtml(src)}" alt="Design preview ${imageIndex + 1}" style="width:120px;height:120px;border:1px solid #d8e2f2;border-radius:10px;object-fit:contain;background:#fff;"><span style="font-size:11px;color:#6a7e9f;">${imageIndex === 0 ? 'Front' : (imageIndex === 1 ? 'Back' : 'Preview')}</span></div>`).join('')}</div>` : ''}
        ${downloadButtons ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 4px;">${downloadButtons}</div>` : ''}
        ${details.length ? `<ul style="margin:8px 0 0 18px;padding:0;">${details.map((line) => `<li style="margin:4px 0;">${escapeHtml(line)}</li>`).join('')}</ul>` : ''}
      </div>`;
    }).join('')
    : '<p>No items listed.</p>';

  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#0f213a;line-height:1.45;">
    <h2 style="margin:0 0 10px;">New ${escapeHtml(String(order?.source || 'stripe').toUpperCase())} order received</h2>
    <p style="margin:0 0 8px;"><strong>Order ID:</strong> ${escapeHtml(order?.id || 'Unknown')}</p>
    <p style="margin:0 0 8px;"><strong>Status:</strong> ${escapeHtml(order?.status || 'pending')}</p>
    <p style="margin:0 0 8px;"><strong>Total:</strong> $${Number(order?.total || 0).toFixed(2)}</p>
    <p style="margin:0 0 8px;"><strong>Fulfillment:</strong> ${escapeHtml(fulfillmentMethod === 'pickup' ? 'Pickup' : 'Delivery')}</p>
    <p style="margin:0 0 8px;"><strong>${escapeHtml(fulfillmentMethod === 'pickup' ? 'Pickup Charge' : 'Delivery Charge')}:</strong> ${escapeHtml(fulfillmentMethod === 'pickup' ? 'Free' : `$${shippingAmount.toFixed(2)}`)}</p>
    <p style="margin:0 0 8px;"><strong>Customer:</strong> ${escapeHtml(order?.customer?.name || 'Not provided')}</p>
    <p style="margin:0 0 8px;"><strong>Email:</strong> ${escapeHtml(order?.customer?.email || 'Not provided')}</p>
    <p style="margin:0 0 8px;"><strong>${escapeHtml(fulfillmentMethod === 'pickup' ? 'Pickup Contact' : 'Deliver To')}:</strong> ${escapeHtml(shippingSummary || 'Not provided')}</p>
    <p style="margin:0 0 14px;"><strong>Placed:</strong> ${escapeHtml(order?.createdAt || new Date().toISOString())}</p>
    <h3 style="margin:0 0 10px;">Items</h3>
    ${itemCards}
  </div>`;
}

function getOrderReceiptEmail(order) {
  const customerEmail = normalizeEmail(order?.customer?.email || '');
  if (customerEmail) return customerEmail;
  return normalizeEmail(order?.shipping?.email || '');
}

function getOrderContactName(order) {
  return String(order?.customer?.name || order?.shipping?.fullName || 'Customer').trim() || 'Customer';
}

function buildOwnerNotificationText(order) {
  const source = String(order?.source || 'stripe').toUpperCase();
  const customerName = order?.customer?.name || 'Not provided';
  const customerEmail = order?.customer?.email || 'Not provided';
  const shipping = order?.shipping || {};
  const fulfillmentMethod = String(order?.fulfillmentMethod || shipping?.fulfillmentMethod || 'delivery').toLowerCase() === 'pickup' ? 'pickup' : 'delivery';
  const shippingAmount = Number(order?.shippingAmount || 0);
  const shippingSummary = fulfillmentMethod === 'pickup'
    ? [shipping.fullName || '', shipping.email || ''].filter(Boolean).join(' | ')
    : [
      shipping.fullName || '',
      shipping.addressLine1 || '',
      shipping.addressLine2 || '',
      [shipping.city || '', shipping.state || '', shipping.postalCode || ''].filter(Boolean).join(', '),
      shipping.email || ''
    ].filter(Boolean).join(' | ');
  return [
    `New ${source} order received`,
    `Order ID: ${order?.id || 'Unknown'}`,
    `Status: ${order?.status || 'pending'}`,
    `Total: $${Number(order?.total || 0).toFixed(2)}`,
    `Fulfillment: ${fulfillmentMethod === 'pickup' ? 'Pickup' : 'Delivery'}`,
    `${fulfillmentMethod === 'pickup' ? 'Pickup Charge: Free' : `Delivery Charge: $${shippingAmount.toFixed(2)}`}`,
    `Customer: ${customerName}`,
    `Email: ${customerEmail}`,
    `${fulfillmentMethod === 'pickup' ? 'Pickup Contact' : 'Deliver To'}: ${shippingSummary || 'Not provided'}`,
    `Placed: ${order?.createdAt || new Date().toISOString()}`,
    '',
    'Items:',
    buildOrderItemsSummary(order),
  ].join('\n');
}

function buildCustomerReceiptText(order) {
  const shipping = order?.shipping || {};
  const fulfillmentMethod = String(order?.fulfillmentMethod || shipping?.fulfillmentMethod || 'delivery').toLowerCase() === 'pickup' ? 'pickup' : 'delivery';
  const shippingAmount = Number(order?.shippingAmount || 0);
  const fulfillmentSummary = fulfillmentMethod === 'pickup'
    ? [shipping.fullName || '', shipping.email || ''].filter(Boolean).join(' | ')
    : [
      shipping.fullName || '',
      shipping.addressLine1 || '',
      shipping.addressLine2 || '',
      [shipping.city || '', shipping.state || '', shipping.postalCode || ''].filter(Boolean).join(', '),
      shipping.email || ''
    ].filter(Boolean).join(' | ');

  return [
    `Thanks for your order, ${getOrderContactName(order)}.`,
    '',
    `Order ID: ${order?.id || 'Unknown'}`,
    `Status: ${order?.status || 'pending'}`,
    `Payment Method: ${String(order?.source || 'stripe').toUpperCase()}`,
    `Fulfillment: ${fulfillmentMethod === 'pickup' ? 'Pickup' : 'Delivery'}`,
    `${fulfillmentMethod === 'pickup' ? 'Pickup Charge: Free' : `Delivery Charge: $${shippingAmount.toFixed(2)}`}`,
    `Total: $${Number(order?.total || 0).toFixed(2)}`,
    `${fulfillmentMethod === 'pickup' ? 'Pickup Contact' : 'Deliver To'}: ${fulfillmentSummary || 'Not provided'}`,
    `Placed: ${order?.createdAt || new Date().toISOString()}`,
    '',
    'Items:',
    buildOrderItemsSummary(order),
    '',
    'If you have any questions, reply to this email.',
  ].join('\n');
}

async function sendOwnerEmailNotification(order) {
  const transport = getEmailTransport();
  if (!transport || !OWNER_NOTIFY_EMAIL) return false;

  const previewAssets = buildOwnerPreviewAssets(order);

  await transport.sendMail({
    from: SMTP_FROM,
    to: OWNER_NOTIFY_EMAIL,
    subject: `New order ${order.id} - $${Number(order.total || 0).toFixed(2)}`,
    text: buildOwnerNotificationText(order),
    html: buildOwnerNotificationHtml(order, previewAssets.previewByIndex, previewAssets.downloadByIndex),
    attachments: previewAssets.attachments,
  });

  return true;
}

async function sendCustomerReceiptEmail(order) {
  const transport = getEmailTransport();
  const receiptEmail = getOrderReceiptEmail(order);
  if (!transport || !receiptEmail) return false;

  await transport.sendMail({
    from: SMTP_FROM,
    to: receiptEmail,
    subject: `Your Freedom Works receipt - ${order.id}`,
    text: buildCustomerReceiptText(order),
  });

  return true;
}

async function notifyOwnerOfNewOrder(order) {
  const emailSent = await sendOwnerEmailNotification(order).catch(() => false);

  if (!emailSent) {
    // eslint-disable-next-line no-console
    console.log(`New order saved ${order.id} for $${Number(order.total || 0).toFixed(2)}. Configure SMTP to receive alerts at ${OWNER_NOTIFY_EMAIL || 'your email'}.`);
  }
}

async function sendCustomerReceipt(order) {
  const receiptSent = await sendCustomerReceiptEmail(order).catch(() => false);

  if (!receiptSent) {
    const receiptEmail = getOrderReceiptEmail(order);
    if (!receiptEmail) return;
    // eslint-disable-next-line no-console
    console.log(`Order ${order.id} saved for ${receiptEmail}, but no customer receipt email was sent. Configure SMTP to deliver store receipts.`);
  }
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
}

function createPasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    salt,
    passwordHash: hashPassword(password, salt),
  };
}

function safeEqualHex(a, b) {
  const left = Buffer.from(String(a || ''), 'hex');
  const right = Buffer.from(String(b || ''), 'hex');
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function verifyPassword(password, customer) {
  if (!customer?.salt || !customer?.passwordHash) return false;
  const hashed = hashPassword(password, customer.salt);
  return safeEqualHex(hashed, customer.passwordHash);
}

function signTokenPayload(payload) {
  return crypto
    .createHmac('sha256', AUTH_TOKEN_SECRET)
    .update(payload)
    .digest('base64url');
}

function createAuthToken(subject) {
  const payload = Buffer.from(JSON.stringify({
    id: subject.id,
    email: subject.email,
    role: subject.role || 'customer',
    exp: Date.now() + (1000 * 60 * 60 * 24 * 30),
  })).toString('base64url');
  const signature = signTokenPayload(payload);
  return `${payload}.${signature}`;
}

function verifyAuthToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  const expected = signTokenPayload(payload);
  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (receivedBuffer.length !== expectedBuffer.length
    || !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!parsed?.id || !parsed?.email || !parsed?.exp || parsed.exp < Date.now()) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function getCustomerFromAuthHeader(req) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const payload = verifyAuthToken(token);
  if (!payload || payload.role !== 'customer') return null;
  const customers = readCustomers();
  return customers.find((customer) => customer.id === payload.id && customer.email === payload.email) || null;
}

function getAdminFromAuthHeader(req) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const payload = verifyAuthToken(token);
  if (!payload || payload.role !== 'admin') return null;
  if (payload.id !== 'owner' || payload.email !== OWNER_EMAIL) return null;
  return {
    id: 'owner',
    email: OWNER_EMAIL,
    name: 'Owner',
    role: 'admin',
  };
}

function requireAdmin(req, res, next) {
  const admin = getAdminFromAuthHeader(req);
  if (!admin) {
    return res.status(401).json({ error: 'Owner login required.' });
  }
  req.admin = admin;
  next();
}

function sanitizeCustomer(customer) {
  const rewardPoints = Math.max(0, Math.floor(Number(customer?.rewardPoints || 0)));
  const rewardLifetimePoints = Math.max(rewardPoints, Math.floor(Number(customer?.rewardLifetimePoints || 0)));
  const pointsToNextReward = rewardPoints % REWARDS_POINTS_STEP === 0
    ? 0
    : (REWARDS_POINTS_STEP - (rewardPoints % REWARDS_POINTS_STEP));
  const availableRewardSteps = Math.floor(rewardPoints / REWARDS_POINTS_STEP);
  return {
    id: customer.id,
    name: customer.name || '',
    email: customer.email,
    createdAt: customer.createdAt,
    rewards: {
      points: rewardPoints,
      lifetimePoints: rewardLifetimePoints,
      availableRewardSteps,
      availableCredit: Number((availableRewardSteps * REWARDS_REWARD_STEP_DOLLARS).toFixed(2)),
      pointsToNextReward,
      nextRewardCredit: REWARDS_REWARD_STEP_DOLLARS,
    },
  };
}

function applyRewardsForOrder(order) {
  const customerEmail = normalizeEmail(order?.customer?.email);
  const customerId = String(order?.customer?.id || '').trim();
  if (!customerEmail && !customerId) return { ok: false, pointsEarned: 0 };

  const customers = readCustomers();
  const customerIndex = customers.findIndex((entry) => {
    const sameId = customerId && String(entry?.id || '') === customerId;
    const sameEmail = customerEmail && normalizeEmail(entry?.email) === customerEmail;
    return sameId || sameEmail;
  });
  if (customerIndex < 0) return { ok: false, pointsEarned: 0 };

  const shirtCount = Array.isArray(order?.items) ? order.items.length : 0;
  const pointsEarned = shirtCount > 0
    ? Math.max(0, Math.floor(shirtCount * REWARDS_POINTS_PER_SHIRT))
    : 0;
  if (pointsEarned <= 0) return { ok: true, pointsEarned: 0 };

  const existing = customers[customerIndex] || {};
  const currentPoints = Math.max(0, Math.floor(Number(existing.rewardPoints || 0)));
  const currentLifetimePoints = Math.max(currentPoints, Math.floor(Number(existing.rewardLifetimePoints || 0)));
  const nextPoints = currentPoints + pointsEarned;
  const nextLifetimePoints = currentLifetimePoints + pointsEarned;

  customers[customerIndex] = {
    ...existing,
    rewardPoints: nextPoints,
    rewardLifetimePoints: nextLifetimePoints,
    updatedAt: new Date().toISOString(),
  };
  return { customers, customerIndex, nextPoints, nextLifetimePoints, pointsEarned };
}

async function finalizeRewardsForOrder(order) {
  const result = applyRewardsForOrder(order);
  if (!result || !result.customers) return { ok: result?.ok ?? false, pointsEarned: result?.pointsEarned || 0 };
  await writeCustomers(result.customers);
  return {
    ok: true,
    pointsEarned: result.pointsEarned,
    rewardPoints: result.nextPoints,
    rewardLifetimePoints: result.nextLifetimePoints,
  };
}

function normalizeInventoryColorStockEntries(values) {
  if (!Array.isArray(values)) return [];
  const entries = [];
  const seen = new Set();
  for (const value of values) {
    const color = String(value?.color || '').trim();
    if (!color) continue;
    const rawSize = String(value?.size || '').trim();
    const size = INVENTORY_SIZES.has(rawSize) ? rawSize : '';
    const key = color.toLowerCase() + '|' + size.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Legacy entries (added before per-size tracking existed) may still
    // carry a list of sizes manually flagged out of stock for that color.
    const outOfStockSizes = Array.isArray(value?.outOfStockSizes)
      ? Array.from(new Set(value.outOfStockSizes
          .map((s) => String(s || '').trim())
          .filter((s) => INVENTORY_SIZES.has(s))))
      : [];
    const stock = Math.max(0, Math.round(Number(value?.stock || 0)) || 0);
    entries.push({
      color,
      size,
      stock,
      outOfStock: value?.outOfStock === true,
      outOfStockSizes,
    });
  }
  return entries;
}

function sanitizeInventoryItem(item) {
  return {
    id: item.id,
    name: item.name,
    sku: item.sku || '',
    category: item.category || '',
    stock: Number(item.stock || 0),
    reorderLevel: Number(item.reorderLevel || 0),
    price: Number(item.price || 0),
    active: item.active !== false,
    notes: item.notes || '',
    colorStock: normalizeInventoryColorStockEntries(item.colorStock),
    updatedAt: item.updatedAt || item.createdAt || '',
    createdAt: item.createdAt || '',
  };
}

function getInventorySummary(items) {
  const records = Array.isArray(items) ? items : [];
  return records.reduce((summary, item) => {
    const stock = Number(item.stock || 0);
    const reorderLevel = Number(item.reorderLevel || 0);
    summary.totalItems += 1;
    summary.totalUnits += Math.max(stock, 0);
    if (item.active !== false) summary.activeItems += 1;
    if (stock <= 0) summary.outOfStock += 1;
    if (reorderLevel > 0 && stock > 0 && stock <= reorderLevel) summary.lowStock += 1;
    return summary;
  }, {
    totalItems: 0,
    activeItems: 0,
    totalUnits: 0,
    lowStock: 0,
    outOfStock: 0,
  });
}

function getPublicInventoryStatus() {
  const inventory = readInventory().map(sanitizeInventoryItem);
  const colorMap = new Map();
  let latestUpdatedAt = '';

  inventory.forEach((item) => {
    const updatedAt = String(item?.updatedAt || item?.createdAt || '').trim();
    if (updatedAt && (!latestUpdatedAt || new Date(updatedAt).getTime() > new Date(latestUpdatedAt).getTime())) {
      latestUpdatedAt = updatedAt;
    }

    const entries = Array.isArray(item?.colorStock) ? item.colorStock : [];
    entries.forEach((entry) => {
      const color = String(entry?.color || '').trim();
      if (!color) return;
      const key = color.toLowerCase();
      const existing = colorMap.get(key) || { color, stock: 0, outOfStock: false, sizeMap: new Map() };
      const size = String(entry?.size || '').trim();
      const entryStock = Math.max(0, Math.round(Number(entry?.stock || 0)) || 0);

      if (size) {
        existing.stock += entryStock;
        const sizeEntry = existing.sizeMap.get(size) || { stock: 0, outOfStock: false };
        sizeEntry.stock += entryStock;
        sizeEntry.outOfStock = sizeEntry.outOfStock || entry?.outOfStock === true;
        existing.sizeMap.set(size, sizeEntry);
      } else {
        // Legacy whole-color entry (no size attached) - keeps working the way
        // it always has, applying its flags across the whole color.
        existing.outOfStock = existing.outOfStock || entry?.outOfStock === true;
        existing.stock += entryStock;
        const legacySizes = Array.isArray(entry?.outOfStockSizes) ? entry.outOfStockSizes : [];
        legacySizes.forEach((legacySize) => {
          const sizeEntry = existing.sizeMap.get(legacySize) || { stock: 0, outOfStock: false };
          sizeEntry.outOfStock = true;
          existing.sizeMap.set(legacySize, sizeEntry);
        });
      }

      colorMap.set(key, existing);
    });
  });

  const colors = Array.from(colorMap.values()).map((entry) => {
    const sizes = Array.from(entry.sizeMap.entries()).map(([size, sizeData]) => ({
      size,
      stock: sizeData.stock,
      // A size reads as out of stock either because the owner manually
      // flagged it, or because its own running numeric count hit zero.
      outOfStock: sizeData.outOfStock || sizeData.stock <= 0,
    }));
    const outOfStockSizes = sizes.filter((sizeEntry) => sizeEntry.outOfStock).map((sizeEntry) => sizeEntry.size);
    return {
      color: entry.color,
      stock: entry.stock,
      outOfStock: entry.outOfStock || (sizes.length > 0 && entry.stock <= 0),
      outOfStockSizes,
      sizes,
    };
  });

  return {
    updatedAt: latestUpdatedAt,
    colors: colors.sort((a, b) => a.color.localeCompare(b.color, undefined, { sensitivity: 'base' })),
  };
}

// Called after every order is placed so stock keeps pace with sales without
// the owner having to manually subtract anything - selling 2 pink shirts in
// size Adult M takes 2 off the Safety Pink / Adult M count automatically.
async function decrementInventoryForOrder(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  if (!items.length) return;

  const tally = new Map();
  items.forEach((item) => {
    const colorName = String(item?.shirtColorName || '').trim();
    if (!colorName) return;
    const size = String(item?.shirtSize || '').trim();
    const quantity = Math.max(1, Math.round(Number(item?.quantity || item?.qty || 1)) || 1);
    const key = colorName.toLowerCase() + '|' + size.toLowerCase();
    tally.set(key, (tally.get(key) || 0) + quantity);
  });
  if (!tally.size) return;

  const inventory = readInventory();
  let changed = false;
  inventory.forEach((invItem) => {
    const entries = Array.isArray(invItem?.colorStock) ? invItem.colorStock : [];
    entries.forEach((entry) => {
      const color = String(entry?.color || '').trim().toLowerCase();
      const size = String(entry?.size || '').trim().toLowerCase();
      const key = color + '|' + size;
      const orderedQty = tally.get(key);
      if (!orderedQty) return;
      const currentStock = Math.max(0, Math.round(Number(entry?.stock || 0)) || 0);
      entry.stock = Math.max(0, currentStock - orderedQty);
      changed = true;
    });
  });

  if (changed) {
    await writeInventory(inventory);
  }
}

function getTrendingSales(options) {
  const settings = options || {};
  const limit = Math.min(24, Math.max(1, Math.round(Number(settings.limit || 8)) || 8));
  const days = Math.min(365, Math.max(1, Math.round(Number(settings.days || 90)) || 90));
  const minCreatedAt = Date.now() - (days * 24 * 60 * 60 * 1000);
  const paidOrders = readOrders().filter((order) => String(order?.status || '').toLowerCase() === 'paid');
  const trendMap = new Map();

  for (const order of paidOrders) {
    const createdAtIso = String(order?.createdAt || order?.updatedAt || order?.date || '').trim();
    const createdAtMs = new Date(createdAtIso).getTime();
    if (!Number.isFinite(createdAtMs) || createdAtMs < minCreatedAt) continue;

    const items = Array.isArray(order?.items) ? order.items : [];
    for (const item of items) {
      const quantity = Math.max(1, Math.round(Number(item?.quantity || item?.qty || 1)) || 1);
      const unitPrice = Number(item?.price || 0);
      const lineRevenue = Number.isFinite(unitPrice) ? Number((unitPrice * quantity).toFixed(2)) : 0;
      const normalizedSrc = normalizeDesignFileName(item?.catalogDesignSrc || item?.designFrontFile || item?.designBackFile || '');
      const fallbackName = formatDesignNameFromFile(normalizedSrc);
      const rawName = String(item?.designName || item?.name || fallbackName || 'Trending Design').trim();
      const displayName = rawName || 'Trending Design';
      const trendKey = normalizedSrc || displayName.toLowerCase();
      if (!trendKey) continue;

      const existing = trendMap.get(trendKey) || {
        key: trendKey,
        name: displayName,
        src: normalizedSrc,
        unitsSold: 0,
        revenue: 0,
        orderCount: 0,
        lastSoldAt: createdAtIso,
      };

      existing.name = existing.name || displayName;
      if (!existing.src && normalizedSrc) existing.src = normalizedSrc;
      existing.unitsSold += quantity;
      existing.revenue = Number((existing.revenue + lineRevenue).toFixed(2));
      existing.orderCount += 1;

      const previousSoldMs = new Date(existing.lastSoldAt || 0).getTime();
      if (!Number.isFinite(previousSoldMs) || createdAtMs > previousSoldMs) {
        existing.lastSoldAt = createdAtIso;
      }

      trendMap.set(trendKey, existing);
    }
  }

  return Array.from(trendMap.values())
    .sort((left, right) => {
      const unitsDiff = Number(right.unitsSold || 0) - Number(left.unitsSold || 0);
      if (unitsDiff !== 0) return unitsDiff;
      const revenueDiff = Number(right.revenue || 0) - Number(left.revenue || 0);
      if (revenueDiff !== 0) return revenueDiff;
      const rightMs = new Date(right.lastSoldAt || 0).getTime();
      const leftMs = new Date(left.lastSoldAt || 0).getTime();
      return rightMs - leftMs;
    })
    .slice(0, limit)
    .map((entry, index) => ({
      rank: index + 1,
      name: entry.name,
      src: entry.src || '',
      unitsSold: Number(entry.unitsSold || 0),
      revenue: Number(Number(entry.revenue || 0).toFixed(2)),
      orderCount: Number(entry.orderCount || 0),
      lastSoldAt: entry.lastSoldAt || '',
    }));
}

function formatDesignNameFromFile(value) {
  const base = path.basename(String(value || '').trim());
  if (!base) return '';
  return base
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isOwnerDashboardTestOrder(order) {
  const normalise = (value) => String(value || '').trim().toLowerCase();
  const combined = [
    order?.id,
    order?.source,
    order?.status,
    order?.paymentIntentId,
    order?.customer?.id,
    order?.customer?.name,
    order?.customer?.email,
    order?.shipping?.fullName,
    order?.shipping?.email,
    ...(Array.isArray(order?.items) ? order.items.flatMap((item) => [
      item?.name,
      item?.designName,
      item?.shirtColorName,
      item?.catalogDesignSrc,
      item?.designFrontFile,
      item?.designBackFile,
      item?.sku,
    ]) : []),
  ].map(normalise).join(' ');

  return /(?:^|[^a-z])(test|demo|sample|mock)(?:$|[^a-z])/i.test(combined)
    || ['test', 'demo', 'sample', 'mock'].includes(normalise(order?.source));
}

function getSalesSummary() {
  const orders = readOrders().filter((order) => !isOwnerDashboardTestOrder(order));
  const paidOrders = orders.filter((order) => String(order.status || '').toLowerCase() === 'paid');
  const pendingOrders = orders.filter((order) => String(order.status || '').toLowerCase() !== 'paid');
  const revenue = paidOrders.reduce((sum, order) => sum + Number(order.total || 0), 0);
  const unitsSold = paidOrders.reduce((sum, order) => {
    const items = Array.isArray(order.items) ? order.items : [];
    return sum + items.length;
  }, 0);
  const uniqueCustomers = new Set();
  for (const order of paidOrders) {
    const email = normalizeEmail(order?.customer?.email);
    if (email) uniqueCustomers.add(email);
  }
  const recentOrders = orders.slice(0, 8).map((order) => ({
    id: order.id,
    status: order.status || 'pending',
    total: Number(order.total || 0),
    shippingAmount: Number(order.shippingAmount || 0),
    source: order.source || 'stripe',
    createdAt: order.createdAt,
    customerName: order?.customer?.name || '',
    customerEmail: order?.customer?.email || '',
    shipping: order?.shipping || {},
    items: Array.isArray(order?.items) ? order.items : [],
    itemCount: Array.isArray(order.items) ? order.items.length : 0,
  }));
  const salesBySource = orders.reduce((acc, order) => {
    const source = String(order.source || 'stripe');
    acc[source] = (acc[source] || 0) + Number(order.total || 0);
    return acc;
  }, {});
  const paidSalesTimeline = paidOrders
    .map((order) => ({
      id: order.id,
      createdAt: order.createdAt || order.updatedAt || order.date || null,
      total: Number(order.total || 0),
    }))
    .filter((entry) => entry.createdAt)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const now = new Date();
  const monthlySales = [];
  const monthIndex = new Map();

  for (let offset = 5; offset >= 0; offset -= 1) {
    const bucketDate = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const key = `${bucketDate.getFullYear()}-${String(bucketDate.getMonth() + 1).padStart(2, '0')}`;
    const bucket = {
      key,
      label: bucketDate.toLocaleString('en-US', { month: 'short', year: 'numeric' }),
      total: 0,
      orderCount: 0,
    };
    monthIndex.set(key, monthlySales.length);
    monthlySales.push(bucket);
  }

  for (const order of paidOrders) {
    const createdAt = new Date(order.createdAt || order.updatedAt || order.date || 0);
    if (Number.isNaN(createdAt.getTime())) continue;
    const key = `${createdAt.getFullYear()}-${String(createdAt.getMonth() + 1).padStart(2, '0')}`;
    const bucketIdx = monthIndex.get(key);
    if (bucketIdx === undefined) continue;
    monthlySales[bucketIdx].total += Number(order.total || 0);
    monthlySales[bucketIdx].orderCount += 1;
  }

  for (const bucket of monthlySales) {
    bucket.total = Number(bucket.total.toFixed(2));
  }

  const currentMonth = monthlySales[monthlySales.length - 1] || { label: 'Current Month', total: 0 };
  const previousMonth = monthlySales[monthlySales.length - 2] || { label: 'Previous Month', total: 0 };
  const deltaAmount = Number((currentMonth.total - previousMonth.total).toFixed(2));
  const deltaPercent = previousMonth.total > 0
    ? Number((((currentMonth.total - previousMonth.total) / previousMonth.total) * 100).toFixed(1))
    : (currentMonth.total > 0 ? 100 : 0);
  const monthTrend = {
    currentLabel: currentMonth.label,
    previousLabel: previousMonth.label,
    currentTotal: currentMonth.total,
    previousTotal: previousMonth.total,
    deltaAmount,
    deltaPercent,
    direction: deltaAmount > 0 ? 'up' : (deltaAmount < 0 ? 'down' : 'flat'),
  };

  return {
    revenue: Number(revenue.toFixed(2)),
    orderCount: orders.length,
    paidOrderCount: paidOrders.length,
    pendingOrderCount: pendingOrders.length,
    unitsSold,
    customerCount: uniqueCustomers.size,
    averageOrderValue: paidOrders.length ? Number((revenue / paidOrders.length).toFixed(2)) : 0,
    salesBySource,
    paidSalesTimeline,
    monthlySales,
    monthTrend,
    recentOrders,
  };
}

function getCustomerAccountsSummary() {
  const customers = readCustomers();
  const orders = readOrders();

  const ordersByCustomer = new Map();
  for (const order of orders) {
    const orderCustomer = order?.customer || {};
    const key = String(orderCustomer.id || '').trim() || normalizeEmail(orderCustomer.email);
    if (!key) continue;
    if (!ordersByCustomer.has(key)) ordersByCustomer.set(key, []);
    ordersByCustomer.get(key).push(order);
  }

  const accounts = customers.map((customer) => {
    const key = String(customer.id || '').trim() || normalizeEmail(customer.email);
    const customerOrders = ordersByCustomer.get(key) || [];
    const paidOrders = customerOrders.filter((order) => String(order.status || '').toLowerCase() === 'paid');
    const totalSpent = paidOrders.reduce((sum, order) => sum + Number(order.total || 0), 0);
    const lastOrderAt = customerOrders.reduce((latest, order) => {
      const createdAt = order.createdAt || order.updatedAt || order.date || null;
      if (!createdAt) return latest;
      if (!latest || new Date(createdAt).getTime() > new Date(latest).getTime()) return createdAt;
      return latest;
    }, null);

    return {
      id: customer.id,
      name: customer.name || '',
      email: customer.email,
      createdAt: customer.createdAt,
      rewardPoints: Math.max(0, Math.floor(Number(customer.rewardPoints || 0))),
      orderCount: customerOrders.length,
      totalSpent: Number(totalSpent.toFixed(2)),
      lastOrderAt,
    };
  });

  accounts.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

  return accounts;
}

app.get('/api/admin/customers', requireAdmin, (_req, res) => {
  res.json({ ok: true, customers: getCustomerAccountsSummary() });
});

app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
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
      await writeOrders(existing);
    }
  }

  res.json({ received: true });
});

app.use(express.json({ limit: '15mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/owner' || req.path.endsWith('.html')) {
    setNoCacheHeaders(res);
  }
  next();
});

const THUMB_CACHE_DIR = path.join(__dirname, '.thumb-cache');
try {
  fs.mkdirSync(THUMB_CACHE_DIR, { recursive: true });
} catch (_) {
  // Non-fatal: thumbnails will just be generated on the fly without disk caching.
}

function resolveSourceImagePath(requestedRaw) {
  const requested = path.basename(String(requestedRaw || ''));
  if (!requested) return '';
  const directPath = path.join(__dirname, requested);
  if (fs.existsSync(directPath) && fs.statSync(directPath).isFile()) {
    return directPath;
  }
  const match = getImageIndex().get(requested.toLowerCase());
  return match ? path.join(__dirname, match) : '';
}

function getThumbCachePath(sourcePath, width) {
  const cacheKey = crypto.createHash('md5').update(sourcePath + '|' + width).digest('hex') + '.webp';
  return path.join(THUMB_CACHE_DIR, cacheKey);
}

async function generateThumbBuffer(sourcePath, width) {
  return sharp(sourcePath)
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
}

// Some original design files are 20MB+ print-resolution PNGs, so decoding
// them with sharp on a customer's first request is slow - and Render's free
// plan wipes .thumb-cache/ on every deploy/restart, so that slow first-decode
// happens again after every deploy. To fix this, pre-generate (and disk
// cache) a thumbnail for every catalog design in the background right after
// boot, with limited concurrency so it doesn't spike memory/CPU, instead of
// waiting for real visitors to trigger the slow path.
const THUMB_WARM_WIDTH = 480;
const THUMB_WARM_DELAY_MS = 300;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Processed strictly one design at a time (no concurrency) with a short
// pause in between - a previous version decoded several 20MB+ originals in
// parallel and pushed Render's free 512MB instance out of memory, crashing
// the whole server. Slower to fully warm, but it can never take the site down.
async function warmThumbCache() {
  if (!sharp) return;
  const files = getDesignCatalogFiles();

  for (const file of files) {
    const sourcePath = path.join(__dirname, file);
    const cachedPath = getThumbCachePath(sourcePath, THUMB_WARM_WIDTH);
    if (fs.existsSync(cachedPath)) continue;
    try {
      const buffer = await generateThumbBuffer(sourcePath, THUMB_WARM_WIDTH);
      await fs.promises.writeFile(cachedPath, buffer);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`Thumbnail warmup failed for ${file}:`, err.message || err);
    }
    await wait(THUMB_WARM_DELAY_MS);
  }
  // eslint-disable-next-line no-console
  console.log(`Thumbnail cache warmup complete (${files.length} designs checked).`);
}

// Serves a resized, web-optimized copy of a design image so browsing/catalog
// grids don't have to download the full, print-resolution original (some of
// which are 20MB+). Falls back to the original file if sharp is unavailable
// or resizing fails for any reason.
app.get('/thumb/:name', async (req, res) => {
  const sourcePath = resolveSourceImagePath(req.params.name);
  if (!sourcePath) {
    return res.status(404).send('Asset not found');
  }

  if (!sharp) {
    setImageCacheHeaders(res);
    return res.sendFile(sourcePath);
  }

  const width = Math.min(1200, Math.max(60, parseInt(req.query.w, 10) || 480));
  const cachedPath = getThumbCachePath(sourcePath, width);

  if (fs.existsSync(cachedPath)) {
    setImageCacheHeaders(res);
    res.type('image/webp');
    return res.sendFile(cachedPath);
  }

  try {
    const buffer = await generateThumbBuffer(sourcePath, width);
    fs.writeFile(cachedPath, buffer, () => {});
    setImageCacheHeaders(res);
    res.type('image/webp');
    return res.send(buffer);
  } catch (_) {
    setImageCacheHeaders(res);
    return res.sendFile(sourcePath);
  }
});

app.get('/assets/:name', (req, res) => {
  const requestedRaw = String(req.params.name || '');
  if (!requestedRaw) {
    return res.status(400).send('Missing asset name');
  }

  const requested = path.basename(requestedRaw);
  const directPath = path.join(__dirname, requested);
  if (fs.existsSync(directPath) && fs.statSync(directPath).isFile()) {
    setImageCacheHeaders(res);
    return res.sendFile(directPath);
  }

  const match = getImageIndex().get(requested.toLowerCase());
  if (!match) {
    return res.status(404).send('Asset not found');
  }

  setImageCacheHeaders(res);
  return res.sendFile(path.join(__dirname, match));
});

app.get('/app-config.js', (_req, res) => {
  res.type('application/javascript');
  setNoCacheHeaders(res);
  res.send(
    'window.STRIPE_PUBLISHABLE_KEY = ' + JSON.stringify(STRIPE_PUBLISHABLE_KEY) + ';\n'
    + 'window.STRIPE_TEMP_DOWN = ' + JSON.stringify(!STRIPE_PUBLISHABLE_KEY) + ';\n'
  );
});

app.use(express.static(__dirname, {
  etag: true,
  lastModified: true,
  maxAge: 0,
  setHeaders(res, filePath) {
    const lowerPath = String(filePath || '').toLowerCase();
    const isImage = lowerPath.endsWith('.png')
      || lowerPath.endsWith('.jpg')
      || lowerPath.endsWith('.jpeg')
      || lowerPath.endsWith('.webp')
      || lowerPath.endsWith('.gif')
      || lowerPath.endsWith('.svg')
      || lowerPath.endsWith('.avif');
    if (isImage) {
      setImageCacheHeaders(res);
    } else if (lowerPath.endsWith('.html') || lowerPath.endsWith('.js') || lowerPath.endsWith('.css')) {
      setNoCacheHeaders(res);
    }
  },
}));

app.get('/owner', (_req, res) => {
  res.sendFile(path.join(__dirname, 'owner.html'));
});

app.get('/api/health', async (_req, res) => {
  let redisCustomerCount = null;
  let redisError = null;
  if (isRedisConfigured()) {
    try {
      const raw = await redisCommand(['GET', 'freedom_works:customers']);
      const parsed = typeof raw === 'string' && raw.length ? JSON.parse(raw) : [];
      redisCustomerCount = Array.isArray(parsed) ? parsed.length : null;
    } catch (err) {
      redisError = err.message || String(err);
    }
  }
  res.json({
    ok: true,
    redisConfigured: isRedisConfigured(),
    bootId: BOOT_ID,
    uptimeSeconds: Math.round(process.uptime()),
    customerCount: readCustomers().length,
    redisCustomerCount,
    redisError,
  });
});

app.get('/api/assets-status', (_req, res) => {
  const files = Array.from(getImageIndex().values());
  res.json({
    ok: true,
    imageCount: files.length,
    sample: files.slice(0, 25),
  });
});

app.get('/api/design-catalog', (_req, res) => {
  const files = getDesignCatalogFiles();
  res.json({
    ok: true,
    imageCount: files.length,
    files,
    sales: getSanitizedDesignSales(),
    names: getSanitizedDesignNames(),
  });
});

app.get('/api/inventory-status', (_req, res) => {
  const status = getPublicInventoryStatus();
  res.json({
    ok: true,
    updatedAt: status.updatedAt,
    colors: status.colors,
  });
});

app.get('/api/trending-sales', (req, res) => {
  const limit = Number(req.query?.limit || 8);
  const days = Number(req.query?.days || 90);
  const items = getTrendingSales({ limit, days });
  res.json({
    ok: true,
    limit: Math.min(24, Math.max(1, Math.round(limit) || 8)),
    days: Math.min(365, Math.max(1, Math.round(days) || 90)),
    items,
  });
});

app.post('/api/admin/login', (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const LEGACY_OWNER_EMAIL = normalizeEmail('owner@freedomworks.local');
  const LEGACY_OWNER_PASSWORD = 'ChangeMe123!';
  const isPrimaryMatch = email === OWNER_EMAIL && password === OWNER_PASSWORD;
  const isLegacyMatch = email === LEGACY_OWNER_EMAIL && password === LEGACY_OWNER_PASSWORD;

  if (!isPrimaryMatch && !isLegacyMatch) {
    return res.status(401).json({ error: 'Invalid owner credentials.' });
  }

  const admin = {
    id: 'owner',
    email: OWNER_EMAIL,
    name: 'Owner',
    role: 'admin',
  };

  res.json({
    ok: true,
    token: createAuthToken(admin),
    admin,
  });
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
  res.json({ ok: true, admin: req.admin });
});

app.get('/api/admin/dashboard', requireAdmin, (_req, res) => {
  const inventory = readInventory().map(sanitizeInventoryItem);
  res.json({
    ok: true,
    inventory,
    inventorySummary: getInventorySummary(inventory),
    sales: getSalesSummary(),
    designSales: getSanitizedDesignSales(),
    customers: getCustomerAccountsSummary(),
  });
});

app.get('/api/admin/design-sales', requireAdmin, (_req, res) => {
  res.json({
    ok: true,
    designSales: getSanitizedDesignSales(),
  });
});

app.post('/api/admin/design-sales', requireAdmin, async (req, res) => {
  const requestedSources = Array.isArray(req.body?.srcs)
    ? req.body.srcs
    : (req.body?.src ? [req.body.src] : []);
  const normalizedSources = Array.from(new Set(requestedSources
    .map((value) => normalizeDesignFileName(value))
    .filter(Boolean)));
  const normalizedSizes = normalizeDesignSaleSizes(req.body?.shirtSizes);
  const offerType = normalizeDesignSaleOfferType(req.body?.offerType || (req.body?.bundleQuantity ? 'bundle' : 'single'));
  const offer = getDesignSaleOfferDetails({
    offerType,
    salePrice: req.body?.salePrice,
    salePercent: req.body?.salePercent,
    bundleQuantity: req.body?.bundleQuantity,
    bundlePrice: req.body?.bundlePrice,
  });

  if (!normalizedSources.length) {
    return res.status(400).json({ error: 'At least one valid design is required.' });
  }
  if (!offer) {
    if (offerType === 'bundle') {
      return res.status(400).json({ error: 'Bundle offers need at least 2 shirts, and the bundle total must stay below the regular website price for the sizes on sale.' });
    }
    if (offerType === 'percentage') {
      return res.status(400).json({ error: 'Percentage offers must be greater than 0% and less than 100% off.' });
    }
    return res.status(400).json({ error: 'Sale price must be below the regular website price for the size or sizes on sale.' });
  }

  const current = getActiveDesignSales();
  const now = new Date();
  const endsAt = new Date(now.getTime() + (24 * 60 * 60 * 1000));
  const hadExistingRecords = normalizedSources.some((src) => current.some((record) => normalizeDesignFileName(record?.src || '') === src));
  const sharedOfferGroupId = offer.offerType === 'bundle' ? `bundle_group_${Date.now()}` : '';
  const savedRecords = normalizedSources.map((src, index) => {
    const existingIdx = current.findIndex((record) => normalizeDesignFileName(record?.src || '') === src);
    const nextRecord = {
      id: existingIdx >= 0 ? String(current[existingIdx].id || `sale_${Date.now()}_${index}`) : `sale_${Date.now()}_${index}`,
      src,
      offerGroupId: offer.offerType === 'bundle'
        ? String(current[existingIdx]?.offerGroupId || sharedOfferGroupId)
        : '',
      offerType: offer.offerType,
      salePrice: offer.salePrice,
      salePercent: offer.salePercent,
      bundleQuantity: offer.bundleQuantity,
      bundlePrice: offer.bundlePrice,
      shirtSizes: normalizedSizes,
      startsAt: now.toISOString(),
      endsAt: endsAt.toISOString(),
      createdAt: existingIdx >= 0 ? String(current[existingIdx].createdAt || now.toISOString()) : now.toISOString(),
      updatedAt: now.toISOString(),
    };

    if (existingIdx >= 0) {
      current[existingIdx] = nextRecord;
    } else {
      current.unshift(nextRecord);
    }

    return sanitizeDesignSale(nextRecord);
  });

  await writeDesignSales(current);
  res.status(hadExistingRecords ? 200 : 201).json({
    ok: true,
    designSales: savedRecords,
    designSale: savedRecords[0] || null,
  });
});

app.delete('/api/admin/design-sales/:id', requireAdmin, async (req, res) => {
  const current = getActiveDesignSales();
  const next = current.filter((record) => String(record.id || '') !== String(req.params.id || ''));
  if (next.length === current.length) {
    return res.status(404).json({ error: 'Design sale not found.' });
  }

  await writeDesignSales(next);
  res.json({ ok: true });
});

// Lets the owner add new designs to the storefront gallery straight from the
// dashboard: the browser reads the chosen image file(s) as base64 data URLs
// and posts them here, we decode + save them as regular files in the app's
// root folder, and they show up automatically since getDesignCatalogFiles()
// just scans that folder for image files. No code changes needed per design.
app.post('/api/admin/design-catalog/upload', requireAdmin, (req, res) => {
  const uploads = Array.isArray(req.body?.files) ? req.body.files : [];
  if (!uploads.length) {
    return res.status(400).json({ error: 'Choose at least one image to upload.' });
  }
  if (uploads.length > 25) {
    return res.status(400).json({ error: 'Upload up to 25 images at a time.' });
  }

  const existingNames = new Set(getImageIndex().keys());
  const saved = [];
  const errors = [];

  for (const upload of uploads) {
    const parts = getDataUrlParts(upload?.dataUrl);
    if (!parts || !MIME_TYPE_TO_EXTENSION[parts.mimeType]) {
      errors.push(`${upload?.name || 'file'}: unsupported or invalid image file.`);
      continue;
    }
    const ext = getExtensionForMimeType(parts.mimeType);
    const baseName = sanitizeAttachmentBaseName(upload?.name, `design-${Date.now()}`);
    let fileName = `${baseName}.${ext}`;
    let suffix = 1;
    while (existingNames.has(fileName.toLowerCase())) {
      fileName = `${baseName}-${suffix}.${ext}`;
      suffix += 1;
    }
    try {
      fs.writeFileSync(path.join(__dirname, fileName), Buffer.from(parts.base64Data, 'base64'));
      existingNames.add(fileName.toLowerCase());
      saved.push(fileName);
    } catch (err) {
      errors.push(`${upload?.name || 'file'}: could not save (${err.message || 'unknown error'}).`);
    }
  }

  if (saved.length) getImageIndex();

  res.status(saved.length ? 201 : 400).json({
    ok: saved.length > 0,
    saved,
    errors,
    files: getDesignCatalogFiles(),
  });
});

// Lets the owner give a design a custom display name (shown on the storefront
// gallery/cart instead of the raw uploaded filename) without touching any code.
app.post('/api/admin/design-catalog/name', requireAdmin, async (req, res) => {
  const src = normalizeDesignFileName(req.body?.src || '');
  const name = normalizeTextField(req.body?.name || '', 80);

  if (!src || !getImageIndex().has(src.toLowerCase())) {
    return res.status(400).json({ error: 'Select a valid design image.' });
  }
  if (!name) {
    return res.status(400).json({ error: 'Enter a display name for this design.' });
  }

  const current = readDesignNames();
  const existingIdx = current.findIndex((record) => normalizeDesignFileName(record?.src || '') === src);
  const nextRecord = { src, name, updatedAt: new Date().toISOString() };
  if (existingIdx >= 0) {
    current[existingIdx] = nextRecord;
  } else {
    current.push(nextRecord);
  }

  await writeDesignNames(current);
  res.json({ ok: true, names: getSanitizedDesignNames() });
});

app.post('/api/admin/inventory', requireAdmin, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const sku = String(req.body?.sku || '').trim();
  const category = String(req.body?.category || '').trim();
  const notes = String(req.body?.notes || '').trim();
  const stock = Number(req.body?.stock || 0);
  const reorderLevel = Number(req.body?.reorderLevel || 0);
  const price = Number(req.body?.price || 0);
  const active = req.body?.active !== false;
  const colorStock = normalizeInventoryColorStockEntries(req.body?.colorStock);

  if (!name) {
    return res.status(400).json({ error: 'Item name is required.' });
  }
  if (!Number.isFinite(stock) || stock < 0) {
    return res.status(400).json({ error: 'Stock must be zero or higher.' });
  }
  if (!Number.isFinite(reorderLevel) || reorderLevel < 0) {
    return res.status(400).json({ error: 'Reorder level must be zero or higher.' });
  }
  if (!Number.isFinite(price) || price < 0) {
    return res.status(400).json({ error: 'Price must be zero or higher.' });
  }

  const inventory = readInventory();
  const item = {
    id: `inv_${Date.now()}`,
    name,
    sku,
    category,
    stock,
    reorderLevel,
    price,
    active,
    notes,
    colorStock,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  inventory.unshift(item);
  await writeInventory(inventory);
  res.status(201).json({ ok: true, item: sanitizeInventoryItem(item) });
});

app.put('/api/admin/inventory/:id', requireAdmin, async (req, res) => {
  const inventory = readInventory();
  const idx = inventory.findIndex((item) => item.id === req.params.id);
  if (idx < 0) {
    return res.status(404).json({ error: 'Inventory item not found.' });
  }

  const current = inventory[idx];
  const next = {
    ...current,
    name: String(req.body?.name ?? current.name).trim(),
    sku: String(req.body?.sku ?? current.sku).trim(),
    category: String(req.body?.category ?? current.category).trim(),
    notes: String(req.body?.notes ?? current.notes).trim(),
    stock: Number(req.body?.stock ?? current.stock),
    reorderLevel: Number(req.body?.reorderLevel ?? current.reorderLevel),
    price: Number(req.body?.price ?? current.price),
    active: req.body?.active !== undefined ? req.body.active !== false : current.active !== false,
    colorStock: req.body?.colorStock !== undefined
      ? normalizeInventoryColorStockEntries(req.body?.colorStock)
      : normalizeInventoryColorStockEntries(current.colorStock),
    updatedAt: new Date().toISOString(),
  };

  if (!next.name) {
    return res.status(400).json({ error: 'Item name is required.' });
  }
  if (!Number.isFinite(next.stock) || next.stock < 0) {
    return res.status(400).json({ error: 'Stock must be zero or higher.' });
  }
  if (!Number.isFinite(next.reorderLevel) || next.reorderLevel < 0) {
    return res.status(400).json({ error: 'Reorder level must be zero or higher.' });
  }
  if (!Number.isFinite(next.price) || next.price < 0) {
    return res.status(400).json({ error: 'Price must be zero or higher.' });
  }

  inventory[idx] = next;
  await writeInventory(inventory);
  res.json({ ok: true, item: sanitizeInventoryItem(next) });
});

app.delete('/api/admin/inventory/:id', requireAdmin, async (req, res) => {
  const inventory = readInventory();
  const nextInventory = inventory.filter((item) => item.id !== req.params.id);
  if (nextInventory.length === inventory.length) {
    return res.status(404).json({ error: 'Inventory item not found.' });
  }

  await writeInventory(nextInventory);
  res.json({ ok: true });
});

app.post('/api/customers/register', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');

  if (!name) {
    return res.status(400).json({ error: 'Please enter your name.' });
  }
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const customers = readCustomers();
  if (customers.some((customer) => customer.email === email)) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }

  const passwordRecord = createPasswordRecord(password);
  const customer = {
    id: `cust_${Date.now()}`,
    name,
    email,
    ...passwordRecord,
    rewardPoints: 0,
    rewardLifetimePoints: 0,
    createdAt: new Date().toISOString(),
  };
  customers.unshift(customer);
  // Awaited (with retries inside pushRecordsToRedis) so the new account is
  // durably in Redis before we respond - a fire-and-forget write here can be
  // lost if a deploy kills this process moments later (fresh container
  // hydrates from Redis and this record is gone). If Redis is genuinely
  // unreachable, roll back the local copy and tell the customer to retry
  // instead of silently reporting success for an account that won't survive
  // the next restart/deploy.
  const persisted = await writeCustomers(customers);
  if (!persisted) {
    await writeArrayFile(customersPath, customers.filter((entry) => entry.id !== customer.id));
    return res.status(503).json({ error: 'We could not save your account right now. Please try again in a minute.' });
  }

  res.status(201).json({
    ok: true,
    token: createAuthToken(customer),
    customer: sanitizeCustomer(customer),
  });
});

app.post('/api/customers/login', (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const customers = readCustomers();
  const customer = customers.find((entry) => entry.email === email);
  if (!customer || !verifyPassword(password, customer)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  res.json({
    ok: true,
    token: createAuthToken(customer),
    customer: sanitizeCustomer(customer),
  });
});

app.get('/api/customers/me', (req, res) => {
  const customer = getCustomerFromAuthHeader(req);
  if (!customer) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  res.json({ ok: true, customer: sanitizeCustomer(customer) });
});

app.get('/api/customers/orders', (req, res) => {
  const customer = getCustomerFromAuthHeader(req);
  if (!customer) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  const orders = readOrders()
    .filter((order) => {
      const orderCustomer = order?.customer || {};
      return orderCustomer.id === customer.id || normalizeEmail(orderCustomer.email) === customer.email;
    })
    .map((order) => ({
      id: order.id,
      status: order.status || 'pending',
      source: order.source || 'stripe',
      total: Number(order.total || 0),
      rewardPointsEarned: Math.max(0, Math.floor(Number(order.rewardPointsEarned || 0))),
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      items: Array.isArray(order.items) ? order.items : [],
    }));

  res.json({ ok: true, orders });
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
      payment_method_types: ['card'],
      ...(receiptEmail ? { receipt_email: receiptEmail } : {}),
    });

    res.json({ clientSecret: intent.client_secret, paymentIntentId: intent.id });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to create payment intent.' });
  }
});

app.post('/api/orders', async (req, res) => {
  const payload = req.body || {};
  const items = Array.isArray(payload.items) ? payload.items.map(sanitizeOrderItem) : [];
  const total = Number(payload.total || 0);
  const shippingAmount = Number(payload.shippingAmount || 0);
  const shipping = payload.shipping || {};
  const rawFulfillmentMethod = String(payload.fulfillmentMethod || shipping.fulfillmentMethod || '').toLowerCase().trim();
  if (rawFulfillmentMethod !== 'pickup' && rawFulfillmentMethod !== 'delivery') {
    return res.status(400).json({ error: 'Please choose pickup or delivery for this order.' });
  }
  const fulfillmentMethod = rawFulfillmentMethod;
  const authenticatedCustomer = getCustomerFromAuthHeader(req);

  if (!items.length || total <= 0) {
    return res.status(400).json({ error: 'Order must include at least one item and a positive total.' });
  }
  if (!String(shipping.fullName || '').trim()
    || !String(shipping.email || '').includes('@')) {
    return res.status(400).json({ error: 'A full name and email are required.' });
  }
  if (fulfillmentMethod !== 'pickup' && (!String(shipping.addressLine1 || '').trim()
    || !String(shipping.city || '').trim()
    || !String(shipping.state || '').trim()
    || !String(shipping.postalCode || '').trim())) {
    return res.status(400).json({ error: 'A full delivery address is required.' });
  }

  const order = {
    id: `ord_${Date.now()}`,
    status: payload.paymentIntentId ? 'paid' : 'pending',
    source: payload.source || 'stripe',
    paymentIntentId: payload.paymentIntentId || '',
    fulfillmentMethod,
    customer: {
      id: authenticatedCustomer?.id || payload.customer?.id || '',
      name: authenticatedCustomer?.name || payload.customer?.name || '',
      email: authenticatedCustomer?.email || payload.customer?.email || '',
    },
    shippingAmount: fulfillmentMethod === 'pickup'
      ? 0
      : (Number.isFinite(shippingAmount) && shippingAmount >= 0 ? Number(shippingAmount.toFixed(2)) : 0),
    shipping: {
      fulfillmentMethod,
      fullName: String(shipping.fullName || '').trim(),
      email: normalizeEmail(shipping.email),
      addressLine1: fulfillmentMethod === 'pickup' ? '' : String(shipping.addressLine1 || '').trim(),
      addressLine2: fulfillmentMethod === 'pickup' ? '' : String(shipping.addressLine2 || '').trim(),
      city: fulfillmentMethod === 'pickup' ? '' : String(shipping.city || '').trim(),
      state: fulfillmentMethod === 'pickup' ? '' : String(shipping.state || '').trim(),
      postalCode: fulfillmentMethod === 'pickup' ? '' : String(shipping.postalCode || '').trim(),
      country: String(shipping.country || 'US').trim() || 'US',
    },
    items,
    total,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const rewards = authenticatedCustomer ? await finalizeRewardsForOrder(order) : { ok: false, pointsEarned: 0 };
  if (rewards.ok) {
    order.rewardPointsEarned = Number(rewards.pointsEarned || 0);
  }

  await appendOrder(order);
  decrementInventoryForOrder(order).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to update color inventory for order:', err.message || err);
  });
  notifyOwnerOfNewOrder(order).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to send order notification:', err.message || err);
  });
  sendCustomerReceipt(order).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to send customer receipt:', err.message || err);
  });
  res.status(201).json({ ok: true, orderId: order.id });
});

async function startServer() {
  // data/ is git-ignored (ephemeral on Render), so on a fresh deploy this
  // directory doesn't exist yet. It must exist before we try to hydrate from
  // Redis below, otherwise those writes throw ENOENT, get silently swallowed,
  // and the very next request's ensureDataFiles() call locks in empty files
  // - permanently hiding real data that's still sitting safely in Redis.
  ensureDataFiles();

  await pullAllCollectionsToDisk().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Upstash startup hydrate error:', err.message || err);
  });

  await ensureRandomDailySaleBatch().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Auto random sale generation error:', err.message || err);
  });
  setInterval(() => {
    ensureRandomDailySaleBatch().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Auto random sale generation error:', err.message || err);
    });
  }, AUTO_SALE_CHECK_INTERVAL_MS);

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Server running at http://localhost:${PORT}`);
  });

  // Fire-and-forget: don't block server startup/requests on this, it just
  // fills in the thumbnail cache in the background over the next moments.
  warmThumbCache().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Thumbnail warmup error:', err.message || err);
  });
}

startServer();
