'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 3030);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 24 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });
const doctors = JSON.parse(fs.readFileSync(path.join(ROOT, 'doctors.json'), 'utf8').replace(/^\uFEFF/, ''));
const doctorById = new Map(doctors.map(doctor => [String(doctor.id), doctor]));
const pinFile = path.join(DATA_DIR, 'doctor-pins.json');
let doctorPins = {};
if (fs.existsSync(pinFile)) { try { doctorPins = JSON.parse(fs.readFileSync(pinFile, 'utf8')); } catch { doctorPins = {}; } }
let pinsChanged = false;
for (const doctor of doctors) {
  if (!doctorPins[String(doctor.id)] || String(doctorPins[String(doctor.id)]).length < 8) {
    doctorPins[String(doctor.id)] = crypto.randomBytes(5).toString('hex').toUpperCase();
    pinsChanged = true;
  }
}
if (pinsChanged || !fs.existsSync(pinFile)) fs.writeFileSync(pinFile, JSON.stringify(doctorPins, null, 2), { mode: 0o600 });

const db = new DatabaseSync(path.join(DATA_DIR, 'appointments.sqlite'));
db.exec(`PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  patient_id TEXT,
  owner_key_hash TEXT,
  patient TEXT NOT NULL,
  patient_phone TEXT NOT NULL DEFAULT '',
  condition TEXT NOT NULL,
  doctor_id TEXT NOT NULL,
  doctor_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  visit_time TEXT,
  created_at TEXT NOT NULL
);`);
try { db.exec('ALTER TABLE requests ADD COLUMN patient_id TEXT'); } catch {}
try { db.exec("ALTER TABLE requests ADD COLUMN patient_phone TEXT NOT NULL DEFAULT ''"); } catch {}
try { db.exec('ALTER TABLE requests ADD COLUMN owner_key_hash TEXT'); } catch {}
db.exec('CREATE INDEX IF NOT EXISTS requests_doctor_created ON requests(doctor_id, created_at DESC); CREATE INDEX IF NOT EXISTS requests_owner_created ON requests(owner_key_hash, created_at DESC);');
const insertRequest = db.prepare('INSERT INTO requests (id, owner_key_hash, patient, patient_phone, condition, doctor_id, doctor_json, status, visit_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
const byIds = db.prepare('SELECT * FROM requests WHERE id = ?');
const byDoctor = db.prepare('SELECT * FROM requests WHERE doctor_id = ? ORDER BY created_at DESC');
// Requests created before device ownership was added have no owner hash.
// Keep those legacy requests visible while new requests remain device-scoped.
const byOwner = db.prepare('SELECT * FROM requests WHERE owner_key_hash = ? OR owner_key_hash IS NULL ORDER BY created_at DESC');
const updateStatus = db.prepare('UPDATE requests SET status = ?, visit_time = ? WHERE id = ?');

function rowToRequest(row) {
  return { id: row.id, patient: row.patient, patientPhone: row.patient_phone || '', condition: row.condition, doctor: JSON.parse(row.doctor_json), status: row.status, visitTime: row.visit_time || '', createdAt: row.created_at };
}
function send(res, status, value, headers = {}) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': typeof value === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}
function requireDoctor(req, doctorId) {
  const supplied = Buffer.from(String(req.headers['x-doctor-pin'] || ''));
  const expected = Buffer.from(String(doctorPins[String(doctorId)] || ''));
  return supplied.length === expected.length && expected.length > 0 && crypto.timingSafeEqual(supplied, expected);
}
function deviceOwner(req) {
  const token = String(req.headers['x-patient-device'] || '');
  return /^[a-f0-9]{64}$/i.test(token) ? crypto.createHash('sha256').update(token.toLowerCase()).digest('hex') : '';
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (Buffer.byteLength(body) > MAX_BODY) { reject(new Error('BODY_TOO_LARGE')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('INVALID_JSON')); } });
    req.on('error', reject);
  });
}
function validTime(value) { return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value); }
function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, { ok: true, deviceOwnership: true });
  if (req.method === 'GET' && url.pathname === '/api/doctors') return send(res, 200, doctors);
  if (req.method === 'GET' && url.pathname === '/api/patient-requests') {
    const owner = deviceOwner(req);
    if (!owner) return send(res, 401, { error: 'تعذر التحقق من هذا المتصفح.' });
    return send(res, 200, byOwner.all(owner).map(rowToRequest));
  }
  if (req.method === 'POST' && url.pathname === '/api/requests') {
    const owner = deviceOwner(req);
    if (!owner) return send(res, 401, { error: 'حدّث الصفحة ثم أعد إرسال الطلب.' });
    readJson(req).then(data => {
      const doctor = doctorById.get(String(data.doctorId));
      const condition = String(data.condition || '').trim().slice(0, 120);
      const patient = String(data.patient || '').trim().slice(0, 120);
      if (!doctor || condition.length < 2 || patient.length < 3) return send(res, 400, { error: 'أدخل اسمك ولقبك ونوع المرض، ثم اختر طبيبًا.' });
      const id = crypto.randomUUID(), createdAt = new Date().toISOString();
      insertRequest.run(id, owner, patient, '', condition, String(doctor.id), JSON.stringify(doctor), 'pending', null, createdAt);
      return send(res, 201, rowToRequest(byIds.get(id)));
    }).catch(() => send(res, 400, { error: 'تعذر قراءة الطلب.' }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/doctor-requests') {
    const doctorId = String(url.searchParams.get('doctorId') || '');
    if (!doctorById.has(doctorId)) return send(res, 400, { error: 'الطبيب غير موجود.' });
    if (!requireDoctor(req, doctorId)) return send(res, 401, { error: 'رمز الطبيب غير صحيح.' });
    return send(res, 200, byDoctor.all(doctorId).map(rowToRequest));
  }
  const statusMatch = url.pathname.match(/^\/api\/doctor-requests\/([0-9a-f-]{36})$/i);
  if (req.method === 'PATCH' && statusMatch) {
    readJson(req).then(data => {
      const current = byIds.get(statusMatch[1]);
      if (!current) return send(res, 404, { error: 'الطلب غير موجود.' });
      if (!requireDoctor(req, current.doctor_id)) return send(res, 401, { error: 'رمز الطبيب غير صحيح.' });
      const status = String(data.status || '');
      if (status === 'accepted' && !validTime(data.visitTime)) return send(res, 400, { error: 'أدخل وقت الزيارة بصيغة صحيحة.' });
      if (!['accepted', 'rejected', 'completed'].includes(status)) return send(res, 400, { error: 'حالة الطلب غير صحيحة.' });
      updateStatus.run(status, status === 'accepted' ? data.visitTime : current.visit_time, current.id);
      return send(res, 200, rowToRequest(byIds.get(current.id)));
    }).catch(() => send(res, 400, { error: 'تعذر تحديث حالة الطلب.' }));
    return;
  }
  return send(res, 404, { error: 'المسار غير موجود.' });
}
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); } catch { return send(res, 400, { error: 'عنوان غير صحيح.' }); }
  if (url.pathname.startsWith('/api/')) return api(req, res, url);
  const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  if (!['index.html', 'script.js', 'style.css'].includes(requested)) return send(res, 404, 'غير موجود.');
  const file = path.join(ROOT, requested);
  fs.readFile(file, (error, content) => {
    if (error) return send(res, 404, 'غير موجود.');
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
    res.end(content);
  });
});
server.listen(PORT, HOST, () => {
  console.log(`موعد يعمل على http://localhost:${PORT}`);
  for (const doctor of doctors) console.log(`${doctor.name} — رمز الدخول: ${doctorPins[String(doctor.id)]}`);
  for (const interfaces of Object.values(os.networkInterfaces())) for (const item of interfaces || []) if (item.family === 'IPv4' && !item.internal) console.log(`من الأجهزة على الشبكة: http://${item.address}:${PORT}`);
  console.log('أوقف الخادم عبر Ctrl+C.');
});
process.on('SIGINT', () => { server.close(() => { db.close(); process.exit(0); }); });
