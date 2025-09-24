import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ---------- CORS ----------
const DEFAULT_ALLOWED = ['http://localhost:5173'];
let ALLOWED = DEFAULT_ALLOWED;
try {
  if (process.env.ALLOWED_ORIGINS) {
    const parsed = JSON.parse(process.env.ALLOWED_ORIGINS);
    if (Array.isArray(parsed)) ALLOWED = parsed;
  }
} catch (e) { console.warn('ALLOWED_ORIGINS parse failed, using default', e.message); }

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl / server-to-server
    if (ALLOWED.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true
}));

// ---------- JSON body ----------
app.use(express.json({ limit: '25mb' }));

// ---------- Logger ----------
app.use((req, res, next) => {
  const safeHeaders = {
    origin: req.headers.origin,
    host: req.headers.host,
    'content-type': req.headers['content-type'],
    'user-agent': req.headers['user-agent'],
    'x-mixtli-token': req.headers['x-mixtli-token'] ? '[present]' : undefined,
  };
  console.log('[REQ]', req.method, req.path, { headers: safeHeaders, query: req.query, body: req.body });
  const t0 = Date.now();
  res.on('finish', () => {
    console.log('[RES]', req.method, req.path, res.statusCode, (Date.now() - t0) + 'ms');
  });
  next();
});

// ---------- Security (optional token) ----------
const REQUIRE_TOKEN = String(process.env.REQUIRE_TOKEN || 'false').toLowerCase() === 'true';
const PRIVATE_TOKEN = process.env.X_MIXTLI_TOKEN || '';

app.use((req, res, next) => {
  if (!REQUIRE_TOKEN) return next();
  const got = req.headers['x-mixtli-token'];
  if (!got || got !== PRIVATE_TOKEN) {
    return res.status(401).json({ ok: false, error: 'x-mixtli-token required' });
  }
  next();
});

// ---------- Health ----------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// ---------- Storage (local tmp) ----------
const uploadDir = path.resolve(__dirname, 'tmp', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

// Multer "any()" to accept any field name (file, upload, archivo, etc.)
const uploadAny = multer({ dest: uploadDir });

// ---------- Helpers ----------
function sanitizeFilename(name='file.bin') {
  return String(name).replace(/[\\/]+/g, '_').replace(/[\x00-\x1F]+/g, '').slice(0, 200) || 'file.bin';
}
function randomId(n=16){
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s=''; for(let i=0;i<n;i++){ s += abc[Math.floor(Math.random()*abc.length)]; } return s;
}

// ---------- PRESIGN ----------
app.post('/api/presign', async (req, res) => {
  // Normalize aliases
  const body = req.body || {};
  const filename = sanitizeFilename(body.filename || body.name || body.originalName || body.originalFilename || 'archivo.bin');
  const contentType = body.contentType || body.mimeType || body.type || 'application/octet-stream';
  const size = Number(body.size ?? body.sizeBytes ?? body.length ?? body.bytes ?? 0);
  const folder = body.folder ? String(body.folder).replace(/[^a-zA-Z0-9_\-/]/g,'').slice(0,120) : '';
  const checksum = body.checksum;

  // MODE normalization & validation
  const rawMode = (body.mode ?? body.uploadMode ?? req.query.mode ?? 'link');
  const mode = String(rawMode).trim().toLowerCase();
  const ALLOWED = new Set(['link','post','put']);
  if (!ALLOWED.has(mode)) {
    console.error('Presign: mode inválido', { rawMode, mode, body });
    return res.status(400).json({ ok: false, error: 'mode inválido', detail: { rawMode, mode } });
  }

  if (!filename || !size) {
    return res.status(400).json({ ok: false, error: 'Missing filename/size' });
  }

  const key = (folder ? folder.replace(/\/$/,'') + '/' : '') + filename;
  const token = randomId(24);
  const expiresAt = Date.now() + 15 * 60 * 1000; // 15 min

  if (mode === 'put') {
    // Signed PUT to our own endpoint (local storage)
    const url = `/put/${token}/${encodeURIComponent(key)}`;
    return res.json({ ok: true, mode, key, url, expiresAt, contentType, checksum });
  }

  // link/post modes → POST multipart to our endpoint
  const url = `/upload/${token}/${encodeURIComponent(key)}`;
  return res.json({ ok: true, mode, key, url, expiresAt, contentType, checksum });
});

// ---------- UPLOAD (POST multipart) ----------
app.post('/upload/:token/*', uploadAny.any(), async (req, res) => {
  try{
    // Pick first file if any
    const f = (req.files && req.files[0]) ? req.files[0] : null;
    if(!f){
      return res.status(400).json({ ok:false, error:'No file received. Use multipart/form-data with a file field.' });
    }
    const relPath = req.params[0] || sanitizeFilename(f.originalname);
    const destFull = path.join(uploadDir, relPath);
    fs.mkdirSync(path.dirname(destFull), { recursive: true });
    fs.renameSync(f.path, destFull);

    return res.json({
      ok: true,
      storedAt: destFull,
      size: f.size,
      fieldname: f.fieldname,
      originalname: f.originalname,
      mimetype: f.mimetype,
      key: relPath
    });
  }catch(e){
    console.error('UPLOAD POST error', e);
    return res.status(500).json({ ok:false, error: e.message });
  }
});

// ---------- PUT raw ----------
app.put('/put/:token/*', async (req, res) => {
  try{
    const relPath = req.params[0] || 'archivo.bin';
    const destFull = path.join(uploadDir, relPath);
    fs.mkdirSync(path.dirname(destFull), { recursive: true });

    const tmpPath = destFull + '.part';
    const write = fs.createWriteStream(tmpPath);
    await new Promise((resolve, reject) => {
      req.pipe(write);
      req.on('error', reject);
      write.on('error', reject);
      write.on('finish', resolve);
    });
    fs.renameSync(tmpPath, destFull);

    return res.json({ ok:true, storedAt: destFull, key: relPath });
  }catch(e){
    console.error('PUT error', e);
    return res.status(500).json({ ok:false, error: e.message });
  }
});

// ---------- Root ----------
app.get('/', (req,res)=>{
  res.type('text/plain').send('Mixtli Backend compat ready');
});

// ---------- Start ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Mixtli Backend compat on :${PORT}`);
});