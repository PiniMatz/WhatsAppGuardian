require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const admin = require('firebase-admin');
const { analyzeHebrewText, invalidateFalsePositiveCache, aiStatus } = require('./hebrew_analysis');
const DEFAULT_KEYWORDS = require('./default_keywords');

const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy; needed for correct client IPs (rate limiting)
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Configuration (all optional; see .env.example)
// ---------------------------------------------------------------------------
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TELEGRAM_INCLUDE_TEXT = (process.env.TELEGRAM_INCLUDE_TEXT || 'true').toLowerCase() !== 'false';
const NOTIFY_MIN_CONFIDENCE = Number(process.env.NOTIFY_MIN_CONFIDENCE || 0.5);
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 0); // 0 = keep unsaved alerts forever
const DEDUP_WINDOW_HOURS = Number(process.env.DEDUP_WINDOW_HOURS || 24); // same text within this window = same alert

// ---------------------------------------------------------------------------
// Firebase
// ---------------------------------------------------------------------------
let db = null;
const serviceAccountPath = path.join(__dirname, 'firebase-service-account.json');

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    db = admin.firestore();
    console.log('Firebase Firestore initialized via environment variable.');
  } catch (err) {
    console.error('Error initializing Firebase Admin with env variable:', err.message);
  }
} else if (fs.existsSync(serviceAccountPath)) {
  try {
    admin.initializeApp({ credential: admin.credential.cert(require(serviceAccountPath)) });
    db = admin.firestore();
    console.log('Firebase Firestore initialized via service account file.');
  } catch (err) {
    console.error('Error initializing Firebase Admin with service account file:', err.message);
  }
} else {
  console.warn('WARNING: Firebase credentials not found. Running in local mock (in-memory) mode.');
}

if (!DASHBOARD_PASSWORD) console.warn('WARNING: DASHBOARD_PASSWORD is not set - the dashboard and its API are OPEN to anyone.');
if (!DEVICE_TOKEN) console.warn('WARNING: DEVICE_TOKEN is not set - anyone can post alerts and read the keyword list.');
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) console.warn('Telegram notifications are disabled (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set).');

// ---------------------------------------------------------------------------
// Security: headers, authentication, rate limiting
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
  });
  next();
});

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// true when the secret is not configured (open mode) or valid credentials are presented
function dashboardOk(req) {
  if (!DASHBOARD_PASSWORD) return true;
  const header = req.get('authorization') || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  return safeEqual(idx >= 0 ? decoded.slice(idx + 1) : decoded, DASHBOARD_PASSWORD);
}

function deviceOk(req) {
  if (!DEVICE_TOKEN) return true;
  return safeEqual(req.get('x-device-token') || '', DEVICE_TOKEN);
}

function makeLimiter(windowMs, max) {
  const hits = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, v] of hits) if (v.start < cutoff) hits.delete(k);
  }, windowMs).unref();
  return key => {
    const now = Date.now();
    const rec = hits.get(key);
    if (!rec || now - rec.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return true;
    }
    rec.count++;
    return rec.count <= max;
  };
}

const apiLimiter = makeLimiter(60 * 1000, 240);          // per IP per minute
const failedAuthLimiter = makeLimiter(10 * 60 * 1000, 30); // failed logins per IP per 10 min
const alertLimiter = makeLimiter(60 * 1000, 60);          // alerts per kid per minute

function isDeviceRoute(req) {
  return (req.method === 'POST' && req.path === '/api/alerts') ||
         (req.method === 'GET' && req.path === '/api/config/keywords');
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.use((req, res, next) => {
  if (!apiLimiter(req.ip)) return res.status(429).json({ error: 'Too many requests' });

  let allowed;
  if (isDeviceRoute(req)) {
    if (req.get('x-device-token') || req.method === 'POST') {
      allowed = deviceOk(req);        // the phone app
    } else {
      allowed = dashboardOk(req);     // a logged-in parent viewing the keyword tab
    }
  } else {
    allowed = dashboardOk(req);
  }

  if (!allowed) {
    if (!failedAuthLimiter(req.ip)) return res.status(429).json({ error: 'Too many failed attempts' });
    if (!isDeviceRoute(req)) res.set('WWW-Authenticate', 'Basic realm="WhatsApp Guardian", charset="UTF-8"');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const CATEGORY_LABELS = {
  physical_violence: 'אלימות פיזית / איומים',
  cyberbullying: 'בריונות ברשת / חרם',
  self_harm: 'סכנת פגיעה עצמית',
  none: 'אחר'
};

function str(v, max) {
  return String(v == null ? '' : v).replace(/\u0000/g, '').trim().slice(0, max);
}

function sanitizeAlertInput(body) {
  if (!body || typeof body !== 'object') return null;
  const kid_name = str(body.kid_name, 50);
  const target_text = str(body.target_text, 2000);
  if (!kid_name || !target_text) return null;
  const context = Array.isArray(body.context)
    ? body.context.slice(-10).map(c => ({ sender: str(c && c.sender, 100), text: str(c && c.text, 1000) })).filter(c => c.text)
    : [];
  return {
    kid_name,
    chat_name: str(body.chat_name, 150) || 'וואטסאפ',
    sender: str(body.sender, 100) || 'לא ידוע',
    target_text,
    context
  };
}

function isContextEqual(ctx1, ctx2) {
  if (!ctx1 || !ctx2) return ctx1 === ctx2;
  if (ctx1.length !== ctx2.length) return false;
  for (let i = 0; i < ctx1.length; i++) {
    if (ctx1[i].sender !== ctx2[i].sender || ctx1[i].text !== ctx2[i].text) return false;
  }
  return true;
}

function normalizeText(text) {
  if (!text) return '';
  let clean = text.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F018}-\u{1F0F5}\u{2600}-\u{26FF}]/gu, '');
  clean = clean.replace(/[֑-ׇ]/g, '');          // Hebrew niqqud
  clean = clean.replace(/[^א-תa-zA-Z0-9]/g, ''); // keep letters/digits only
  return clean.toLowerCase();
}

function isDuplicateText(text1, text2) {
  const norm1 = normalizeText(text1);
  const norm2 = normalizeText(text2);
  if (!norm1 || !norm2) return false;
  if (norm1 === norm2) return true;
  if (norm1.includes(norm2) || norm2.includes(norm1)) {
    const minLen = Math.min(norm1.length, norm2.length);
    const maxLen = Math.max(norm1.length, norm2.length);
    if (minLen >= maxLen * 0.6) return true;
  }
  return false;
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

async function commitInChunks(refs, op) {
  // Firestore batches are limited to 500 operations.
  for (let i = 0; i < refs.length; i += 400) {
    const batch = db.batch();
    refs.slice(i, i + 400).forEach(ref => op(batch, ref));
    await batch.commit();
  }
}

// ---------------------------------------------------------------------------
// Alert store: an in-memory, write-through cache in front of Firestore.
// This keeps Firestore reads near zero (free-tier quota is 50k reads/day) and makes
// the dashboard's "has anything changed?" poll free.
// ---------------------------------------------------------------------------
let alertsCache = [];          // newest first, ISO timestamps
let cacheLoaded = !db;         // mock mode starts "loaded" (empty)
let cacheLoading = null;
const versionEpoch = Date.now().toString(36);
let versionCounter = 0;
const currentVersion = () => `${versionEpoch}-${versionCounter}`;
const bumpVersion = () => { versionCounter++; };

function docToAlert(doc) {
  const data = doc.data();
  if (data.timestamp && typeof data.timestamp.toDate === 'function') data.timestamp = data.timestamp.toDate().toISOString();
  return { ...data, id: doc.id };
}

async function ensureLoaded() {
  if (cacheLoaded) return;
  if (!cacheLoading) {
    cacheLoading = (async () => {
      const [recent, saved] = await Promise.all([
        db.collection('alerts').orderBy('timestamp', 'desc').limit(100).get(),
        db.collection('alerts').where('saved', '==', true).limit(200).get()
      ]);
      const map = new Map();
      recent.forEach(d => map.set(d.id, docToAlert(d)));
      saved.forEach(d => map.set(d.id, docToAlert(d)));
      alertsCache = [...map.values()].sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
      cacheLoaded = true;
      bumpVersion();
    })().finally(() => { cacheLoading = null; });
  }
  await cacheLoading;
}

const findCached = id => alertsCache.find(a => a.id === id);
function removeCached(ids) {
  const set = new Set(ids);
  alertsCache = alertsCache.filter(a => !set.has(a.id));
  bumpVersion();
}
function patchCached(id, fields) {
  const a = findCached(id);
  if (a) Object.assign(a, fields);
  bumpVersion();
}

async function createAlert(data) {
  const nowIso = new Date().toISOString();
  let id = 'alert_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
  if (db) {
    try {
      const ref = await db.collection('alerts').add({ ...data, timestamp: admin.firestore.FieldValue.serverTimestamp() });
      id = ref.id;
    } catch (err) {
      console.error('Failed to save alert to Firestore (kept in memory only):', err.message);
    }
  }
  const alert = { ...data, id, timestamp: nowIso };
  alertsCache.unshift(alert);
  bumpVersion();
  return alert;
}

async function updateAlert(id, fields, { touch = true } = {}) {
  const full = touch ? { ...fields, timestamp: admin.firestore.FieldValue.serverTimestamp() } : fields;
  if (db && !id.startsWith('alert_')) {
    try {
      await db.collection('alerts').doc(id).update(full);
    } catch (err) {
      console.error('Failed to update alert in Firestore:', err.message);
    }
  }
  const cached = { ...fields };
  if (touch) cached.timestamp = new Date().toISOString();
  patchCached(id, cached);
  if (touch) alertsCache.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

// ---------------------------------------------------------------------------
// Telegram notifications
// ---------------------------------------------------------------------------
async function notifyTelegram(alert, reason) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const lines = [
    reason === 'failed' ? '⚠️ <b>התרעה חדשה - ניתוח ה-AI נכשל, יש לבדוק ידנית</b>' : '🚨 <b>התרעה חדשה - שומר הוואטסאפ</b>',
    `👤 ילד/ה: <b>${escHtml(alert.kid_name)}</b>`,
    `💬 צ'אט: ${escHtml(alert.chat_name)}`,
    `✍️ נכתב ע"י: ${escHtml(alert.sender)}`
  ];
  if (TELEGRAM_INCLUDE_TEXT) lines.push(`📝 "${escHtml(alert.target_text.slice(0, 500))}"`);
  if (reason !== 'failed') {
    lines.push(`🏷️ ${escHtml(CATEGORY_LABELS[alert.category] || alert.category)} (${Math.round((alert.confidence || 0) * 100)}%)`);
    if (alert.explanation_hebrew) lines.push(`💡 ${escHtml(alert.explanation_hebrew)}`);
  }
  if (PUBLIC_URL) lines.push(PUBLIC_URL);
  try {
    const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: lines.join('\n'), parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) console.error('Telegram send failed:', resp.status, (await resp.text()).slice(0, 200));
  } catch (err) {
    console.error('Telegram send error:', err.message);
  }
}

function shouldNotify(analysis, previous) {
  if (analysis.analysis_failed) return previous ? false : 'failed';
  if (!analysis.is_threat || analysis.confidence < NOTIFY_MIN_CONFIDENCE) return false;
  // On an update of an existing alert, only notify when it newly became a threat or the category changed.
  if (previous && previous.is_threat && previous.category === analysis.category) return false;
  return 'threat';
}

// ---------------------------------------------------------------------------
// Alert ingestion
// ---------------------------------------------------------------------------
const activeRequests = new Set(); // in-flight lock against simultaneous duplicate posts

app.post('/api/alerts', async (req, res) => {
  const input = sanitizeAlertInput(req.body);
  if (!input) return res.status(400).json({ error: 'Missing kid_name or target_text' });
  if (!alertLimiter(input.kid_name)) return res.status(429).json({ error: 'Too many alerts' });

  const requestKey = `${input.kid_name}_${normalizeText(input.target_text).substring(0, 100)}`;
  if (activeRequests.has(requestKey)) {
    return res.json({ success: true, duplicate: true, note: 'inflight duplicate caught' });
  }
  activeRequests.add(requestKey);

  try {
    try {
      await ensureLoaded();
    } catch (err) {
      console.error('Could not load alerts cache:', err.message);
    }

    // Deduplication / evolving context: look at this child's 30 most recent alerts.
    const windowStart = Date.now() - DEDUP_WINDOW_HOURS * 3600000;
    const recentForKid = alertsCache
      .filter(a => a.kid_name === input.kid_name && new Date(a.timestamp).getTime() >= windowStart)
      .slice(0, 30);
    const existing = recentForKid.find(a => isDuplicateText(a.target_text, input.target_text));

    if (existing) {
      const isNewTextLonger = input.target_text.length > existing.target_text.length;
      const contextChanged = !isContextEqual(existing.context, input.context);
      if (contextChanged || isNewTextLonger || existing.analysis_failed) {
        const textToKeep = isNewTextLonger ? input.target_text : existing.target_text;
        const analysis = await analyzeHebrewText(textToKeep, input.context, db, input.kid_name);
        await updateAlert(existing.id, {
          chat_name: input.chat_name,
          sender: input.sender,
          target_text: textToKeep,
          context: input.context,
          is_threat: analysis.is_threat,
          category: analysis.category,
          confidence: analysis.confidence,
          explanation_hebrew: analysis.explanation_hebrew,
          analysis_failed: !!analysis.analysis_failed
        });
        const reason = shouldNotify(analysis, existing);
        if (reason) notifyTelegram({ ...existing, ...input, target_text: textToKeep, ...analysis }, reason);
        return res.json({ success: true, updated: true, analysis });
      }
      await updateAlert(existing.id, {}); // just extend the time window
      return res.json({ success: true, duplicate: true });
    }

    const analysis = await analyzeHebrewText(input.target_text, input.context, db, input.kid_name);
    const alert = await createAlert({
      ...input,
      is_threat: analysis.is_threat,
      category: analysis.category,
      confidence: analysis.confidence,
      explanation_hebrew: analysis.explanation_hebrew,
      analysis_failed: !!analysis.analysis_failed
    });
    console.log(`Alert ${alert.id} stored (threat=${analysis.is_threat}, category=${analysis.category}, failed=${!!analysis.analysis_failed})`);

    const reason = shouldNotify(analysis, null);
    if (reason) notifyTelegram(alert, reason);

    res.json({ success: true, analysis });
  } catch (err) {
    console.error('Error handling alert:', err.message);
    res.status(500).json({ error: 'Internal error' });
  } finally {
    setTimeout(() => activeRequests.delete(requestKey), 5000);
  }
});

// Dashboard poll: pass ?v=<version>; if nothing changed the server answers without touching the database.
app.get('/api/alerts', async (req, res) => {
  try {
    await ensureLoaded();
  } catch (err) {
    console.error('Failed to load alerts from Firestore:', err.message);
    return res.status(503).json({ error: 'Database unavailable' });
  }
  if (req.query.v && req.query.v === currentVersion()) return res.json({ version: currentVersion(), unchanged: true });
  res.json({ version: currentVersion(), alerts: alertsCache });
});

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------
let keywordsCache = null;

async function loadKeywords() {
  if (keywordsCache) return keywordsCache;
  if (db) {
    try {
      const doc = await db.collection('config').doc('keywords').get();
      if (doc.exists && Array.isArray(doc.data().list) && doc.data().list.length > 0) {
        keywordsCache = doc.data().list;
      } else {
        keywordsCache = [...DEFAULT_KEYWORDS];
        await db.collection('config').doc('keywords').set({ list: keywordsCache });
      }
    } catch (err) {
      console.error('Failed to fetch keywords from Firestore:', err.message);
      return [...DEFAULT_KEYWORDS];
    }
  } else {
    keywordsCache = [...DEFAULT_KEYWORDS];
  }
  return keywordsCache;
}

async function saveKeywords(list) {
  if (db) await db.collection('config').doc('keywords').set({ list });
  keywordsCache = list;
}

app.get('/api/config/keywords', async (req, res) => {
  res.json({ keywords: await loadKeywords() });
});

app.post('/api/config/keywords', async (req, res) => {
  const { keywords } = req.body || {};
  if (!Array.isArray(keywords)) return res.status(400).json({ error: 'Missing or invalid keywords array' });
  const clean = [...new Set(keywords.map(k => str(k, 60)).filter(Boolean))].slice(0, 1000);
  if (clean.length === 0) return res.status(400).json({ error: 'Keyword list cannot be empty (this would disable monitoring)' });
  try {
    await saveKeywords(clean);
    res.json({ success: true, keywords: clean });
  } catch (err) {
    console.error('Failed to save keywords:', err.message);
    res.status(500).json({ error: 'Failed to save keywords' });
  }
});

app.post('/api/config/keywords/reset', async (req, res) => {
  try {
    await saveKeywords([...DEFAULT_KEYWORDS]);
    res.json({ success: true, keywords: DEFAULT_KEYWORDS });
  } catch (err) {
    console.error('Failed to reset keywords:', err.message);
    res.status(500).json({ error: 'Failed to reset keywords' });
  }
});

// ---------------------------------------------------------------------------
// Alert management (dashboard)
// ---------------------------------------------------------------------------
function validId(req, res) {
  if (!ID_RE.test(req.params.id)) {
    res.status(400).json({ error: 'Invalid id' });
    return false;
  }
  return true;
}

function validIds(req, res) {
  const ids = req.body && req.body.ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 1000 || !ids.every(i => typeof i === 'string' && ID_RE.test(i))) {
    res.status(400).json({ error: 'Missing or invalid ids array' });
    return null;
  }
  return ids;
}

app.delete('/api/alerts/:id', async (req, res) => {
  if (!validId(req, res)) return;
  try {
    if (db && !req.params.id.startsWith('alert_')) await db.collection('alerts').doc(req.params.id).delete();
    await ensureLoaded().catch(() => {});
    removeCached([req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting alert:', err.message);
    res.status(500).json({ error: 'Failed to delete alert' });
  }
});

app.post('/api/alerts/:id/dismiss', async (req, res) => {
  if (!validId(req, res)) return;
  const id = req.params.id;
  try {
    await ensureLoaded().catch(() => {});
    const alert = findCached(id);
    if (db && !id.startsWith('alert_')) {
      let data = alert;
      if (!data) {
        const doc = await db.collection('alerts').doc(id).get();
        data = doc.exists ? doc.data() : null;
      }
      if (data) {
        await db.collection('false_positives').add({
          kid_name: data.kid_name || '',
          target_text: data.target_text,
          context: data.context || [],
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        invalidateFalsePositiveCache();
      }
      await db.collection('alerts').doc(id).delete();
    }
    removeCached([id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error dismissing alert:', err.message);
    res.status(500).json({ error: 'Failed to dismiss alert' });
  }
});

app.post('/api/alerts/:id/unsave', async (req, res) => {
  if (!validId(req, res)) return;
  try {
    if (db && !req.params.id.startsWith('alert_')) await db.collection('alerts').doc(req.params.id).update({ saved: false });
    await ensureLoaded().catch(() => {});
    patchCached(req.params.id, { saved: false });
    res.json({ success: true });
  } catch (err) {
    console.error('Error unsaving alert:', err.message);
    res.status(500).json({ error: 'Failed to unsave alert' });
  }
});

app.post('/api/alerts/bulk-save', async (req, res) => {
  const ids = validIds(req, res);
  if (!ids) return;
  try {
    if (db) {
      const real = ids.filter(i => !i.startsWith('alert_'));
      await commitInChunks(real.map(i => db.collection('alerts').doc(i)), (b, ref) => b.update(ref, { saved: true }));
    }
    await ensureLoaded().catch(() => {});
    ids.forEach(i => patchCached(i, { saved: true }));
    res.json({ success: true });
  } catch (err) {
    console.error('Error bulk saving alerts:', err.message);
    res.status(500).json({ error: 'Failed to save alerts' });
  }
});

app.post('/api/alerts/bulk-delete', async (req, res) => {
  const ids = validIds(req, res);
  if (!ids) return;
  try {
    if (db) {
      const real = ids.filter(i => !i.startsWith('alert_'));
      await commitInChunks(real.map(i => db.collection('alerts').doc(i)), (b, ref) => b.delete(ref));
    }
    await ensureLoaded().catch(() => {});
    removeCached(ids);
    res.json({ success: true });
  } catch (err) {
    console.error('Error bulk deleting alerts:', err.message);
    res.status(500).json({ error: 'Failed to delete alerts' });
  }
});

app.post('/api/alerts/delete-unsaved', async (req, res) => {
  try {
    let count = 0;
    if (db) {
      const snapshot = await db.collection('alerts').select('saved').get();
      const refs = snapshot.docs.filter(d => d.data().saved !== true).map(d => d.ref);
      await commitInChunks(refs, (b, ref) => b.delete(ref));
      count = refs.length;
    } else {
      count = alertsCache.filter(a => a.saved !== true).length;
    }
    alertsCache = alertsCache.filter(a => a.saved === true);
    bumpVersion();
    res.json({ success: true, count });
  } catch (err) {
    console.error('Error deleting unsaved alerts:', err.message);
    res.status(500).json({ error: 'Failed to delete alerts' });
  }
});

app.post('/api/kids/delete', async (req, res) => {
  const kid_name = str(req.body && req.body.kid_name, 50);
  if (!kid_name) return res.status(400).json({ error: 'Missing kid_name' });
  try {
    if (db) {
      const snapshot = await db.collection('alerts').where('kid_name', '==', kid_name).select().get();
      await commitInChunks(snapshot.docs.map(d => d.ref), (b, ref) => b.delete(ref));
    }
    alertsCache = alertsCache.filter(a => a.kid_name !== kid_name);
    bumpVersion();
    res.json({ success: true });
  } catch (err) {
    console.error('Error removing kid alerts:', err.message);
    res.status(500).json({ error: 'Failed to remove child' });
  }
});

// ---------------------------------------------------------------------------
// Status + notification test (dashboard)
// ---------------------------------------------------------------------------
app.get('/api/status', (req, res) => {
  res.json({
    database: db ? 'firestore' : 'memory (data lost on restart!)',
    ai: { model: aiStatus.model, lastOk: aiStatus.lastOk, lastError: aiStatus.lastError, lastErrorAt: aiStatus.lastErrorAt },
    telegram: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    auth: { dashboard: !!DASHBOARD_PASSWORD, device: !!DEVICE_TOKEN },
    retentionDays: RETENTION_DAYS
  });
});

app.post('/api/test-notification', async (req, res) => {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return res.status(400).json({ error: 'Telegram is not configured on the server' });
  await notifyTelegram({
    kid_name: 'בדיקה', chat_name: 'הודעת בדיקה', sender: 'שומר הוואטסאפ', target_text: 'זוהי הודעת בדיקה - ההתראות עובדות 🎉',
    category: 'none', confidence: 1, explanation_hebrew: ''
  }, 'threat');
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Background jobs
// ---------------------------------------------------------------------------
async function retryFailedAnalyses() {
  try {
    await ensureLoaded();
    const failed = alertsCache.filter(a => a.analysis_failed).slice(0, 5);
    for (const alert of failed) {
      const analysis = await analyzeHebrewText(alert.target_text, alert.context || [], db, alert.kid_name);
      if (analysis.analysis_failed) continue;
      await updateAlert(alert.id, {
        is_threat: analysis.is_threat,
        category: analysis.category,
        confidence: analysis.confidence,
        explanation_hebrew: analysis.explanation_hebrew,
        analysis_failed: false
      }, { touch: false });
      const reason = shouldNotify(analysis, null);
      if (reason) notifyTelegram({ ...alert, ...analysis }, reason);
    }
  } catch (err) {
    console.error('retryFailedAnalyses error:', err.message);
  }
}

async function purgeOldAlerts() {
  if (!RETENTION_DAYS || RETENTION_DAYS < 1) return;
  const cutoffMs = Date.now() - RETENTION_DAYS * 86400000;
  try {
    if (db) {
      const snap = await db.collection('alerts').where('timestamp', '<', new Date(cutoffMs)).select('saved').limit(400).get();
      const refs = snap.docs.filter(d => d.data().saved !== true).map(d => d.ref);
      await commitInChunks(refs, (b, ref) => b.delete(ref));
    }
    alertsCache = alertsCache.filter(a => a.saved === true || new Date(a.timestamp).getTime() >= cutoffMs);
    bumpVersion();
  } catch (err) {
    console.error('purgeOldAlerts error:', err.message);
  }
}

setInterval(retryFailedAnalyses, 5 * 60 * 1000).unref();
setInterval(purgeOldAlerts, 24 * 3600 * 1000).unref();
setTimeout(purgeOldAlerts, 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Errors + startup
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large' });
  console.error('Unhandled error:', err && err.message);
  res.status(500).json({ error: 'Internal error' });
});

process.on('unhandledRejection', err => console.error('Unhandled rejection:', err && err.message));

if (require.main === module) {
  app.listen(PORT, () => console.log(`WhatsApp Guardian backend listening on port ${PORT}`));
}

module.exports = { app, sanitizeAlertInput, isDuplicateText, normalizeText };
