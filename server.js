import express from 'express';
import cors from 'cors';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const app = express();

// ---------- CORS ----------
let ALLOWED = ['http://localhost:5173'];
try {
  if (process.env.ALLOWED_ORIGINS) {
    const parsed = JSON.parse(process.env.ALLOWED_ORIGINS);
    if (Array.isArray(parsed)) ALLOWED = parsed;
  }
} catch (e) { console.warn('ALLOWED_ORIGINS parse failed', e.message); }

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // allow curl / S2S
    if (ALLOWED.includes(origin)) return cb(null, true);
    return cb(null, false);
  }
}));

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
  res.on('finish', () => console.log('[RES]', req.method, req.path, res.statusCode, (Date.now()-t0)+'ms'));
  next();
});

// ---------- Security (optional) ----------
const REQUIRE_TOKEN = String(process.env.REQUIRE_TOKEN||'false').toLowerCase()==='true';
const PRIVATE_TOKEN = process.env.X_MIXTLI_TOKEN || '';
app.use((req,res,next)=>{
  if(!REQUIRE_TOKEN) return next();
  if(req.headers['x-mixtli-token'] !== PRIVATE_TOKEN){
    return res.status(401).json({ok:false,error:'x-mixtli-token required'});
  }
  next();
});

// ---------- Env validation ----------
function assertEnv(name){
  const v = process.env[name];
  if(!v || String(v).trim()===''){
    throw new Error(`Missing env ${name}`);
  }
  return v;
}

let envError = null;
let R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_REGION, R2_FORCE_PATH_STYLE;
try{
  R2_ACCOUNT_ID = assertEnv('R2_ACCOUNT_ID');
  R2_ACCESS_KEY_ID = assertEnv('R2_ACCESS_KEY_ID');
  R2_SECRET_ACCESS_KEY = assertEnv('R2_SECRET_ACCESS_KEY');
  R2_BUCKET = assertEnv('R2_BUCKET');
  R2_REGION = process.env.R2_REGION || 'auto';
  R2_FORCE_PATH_STYLE = String(process.env.R2_FORCE_PATH_STYLE||'true').toLowerCase()==='true';
}catch(e){
  envError = e.message;
  console.error('ENV ERROR:', e.message);
}

// ---------- R2 Client ----------
let R2 = null;
if(!envError){
  R2 = new S3Client({
    region: R2_REGION,
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    forcePathStyle: R2_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY
    }
  });
}
const EXPIRES = Number(process.env.PRESIGN_EXPIRES || 900);

// ---------- Health ----------
app.get('/api/health', (req,res)=> res.json({ ok:true, ts: Date.now(), r2Ready: !envError }));

// ---------- Config echo (no secrets) ----------
app.get('/api/config', (req,res)=>{
  res.json({
    ok: true,
    bucket: R2_BUCKET || null,
    accountId: R2_ACCOUNT_ID ? (R2_ACCOUNT_ID.slice(0,6)+'…') : null,
    region: R2_REGION || null,
    forcePathStyle: R2_FORCE_PATH_STYLE,
    allowedOrigins: ALLOWED,
    presignExpires: EXPIRES,
    requireToken: REQUIRE_TOKEN,
    envError
  });
});

// ---------- Helpers ----------
function cleanName(s){
  return String(s).replace(/[^a-zA-Z0-9_\-.]/g,'_').slice(0,200) || 'file.bin';
}
function cleanFolder(s){
  const x = String(s).replace(/^\/+|\/+$/g,'').replace(/[^a-zA-Z0-9_\-/]/g,'_');
  return x ? (x + '/') : '';
}

// ---------- Presign PUT to R2 ----------
app.post('/api/presign', async (req,res)=>{
  try{
    if(envError) return res.status(500).json({ ok:false, error:'env_invalid', detail: envError });

    const b = req.body || {};
    const rawName = b.filename || b.name || b.originalName || b.originalFilename;
    const contentType = b.contentType || b.mimeType || b.type || 'application/octet-stream';
    const size = Number(b.size ?? b.sizeBytes ?? b.length ?? b.bytes ?? 0);

    if(!rawName) return res.status(400).json({ ok:false, error:'Missing filename' });
    if(!size)     return res.status(400).json({ ok:false, error:'Missing size' });

    const key = cleanFolder(b.folder || '') + cleanName(rawName);

    const cmd = new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      ContentType: contentType,
    });
    const url = await getSignedUrl(R2, cmd, { expiresIn: EXPIRES });

    return res.json({
      ok: true,
      method: 'PUT',
      url,
      key,
      contentType,
      expiresAt: Date.now() + EXPIRES * 1000
    });
  }catch(e){
    console.error('presign_failed', e);
    return res.status(500).json({ ok:false, error:'presign_failed' });
  }
});

// ---------- Root ----------
app.get('/', (req,res)=> res.type('text/plain').send('Mixtli R2 presign ready'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=> console.log('Mixtli R2 presign on :' + PORT));