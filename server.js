import express from 'express';
import cors from 'cors';
import multer from 'multer';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const app = express();

// ---------- CORS ----------
let ALLOWED = ['http://localhost:5173'];
try {
  if (process.env.ALLOWED_ORIGINS) {
    const parsed = JSON.parse(process.env.ALLOWED_ORIGINS);
    if (Array.isArray(parsed)) ALLOWED = parsed;
  }
} catch {}
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // allow curl / S2S
    if (ALLOWED.includes(origin)) return cb(null, true);
    return cb(null, false);
  }
}));
app.use(express.json({ limit: '25mb' }));

// ---------- Logger ----------
app.use((req,res,next)=>{
  const safe = {
    origin: req.headers.origin,
    host: req.headers.host,
    'content-type': req.headers['content-type'],
    'user-agent': req.headers['user-agent']
  };
  console.log('[REQ]', req.method, req.path, {headers: safe, query: req.query});
  const t=Date.now(); res.on('finish',()=>console.log('[RES]', req.method, req.path, res.statusCode, (Date.now()-t)+'ms')); next();
});

// ---------- Env ----------
function need(k){const v=process.env[k]; if(!v) throw new Error('Missing env '+k); return v;}
const R2_ACCOUNT_ID = need('R2_ACCOUNT_ID');
const R2_ACCESS_KEY_ID = need('R2_ACCESS_KEY_ID');
const R2_SECRET_ACCESS_KEY = need('R2_SECRET_ACCESS_KEY');
const R2_BUCKET = need('R2_BUCKET');
const R2_REGION = process.env.R2_REGION || 'auto';
const R2_FORCE_PATH_STYLE = String(process.env.R2_FORCE_PATH_STYLE||'true').toLowerCase()==='true';
const EXPIRES = Number(process.env.PRESIGN_EXPIRES || 900);

// token opcional
const REQUIRE_TOKEN = String(process.env.REQUIRE_TOKEN||'false').toLowerCase()==='true';
const PRIVATE_TOKEN = process.env.X_MIXTLI_TOKEN || '';
app.use((req,res,next)=>{
  if(!REQUIRE_TOKEN) return next();
  if(req.headers['x-mixtli-token'] !== PRIVATE_TOKEN){
    return res.status(401).json({ok:false,error:'x-mixtli-token required'});
  }
  next();
});

// ---------- R2 Client ----------
const R2 = new S3Client({
  region: R2_REGION,
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  forcePathStyle: R2_FORCE_PATH_STYLE,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY }
});

// ---------- Health ----------
app.get('/api/health', (req,res)=> res.json({ok:true, ts:Date.now()}));

// ---------- Config ----------
app.get('/api/config', (req,res)=> res.json({
  ok:true,
  bucket:R2_BUCKET,
  accountId:R2_ACCOUNT_ID.slice(0,6)+'…',
  allowedOrigins:ALLOWED,
  expires:EXPIRES,
  requireToken: REQUIRE_TOKEN
}));

// ---------- Helpers ----------
function cleanName(s){ return String(s||'file.bin').replace(/[^a-zA-Z0-9_\-.]/g,'_').slice(0,200); }
function cleanFolder(s){ const x = String(s||'').replace(/^\/+|\/+$/g,'').replace(/[^a-zA-Z0-9_\-/]/g,'_'); return x? x+'/' : ''; }
const upload = multer();

// ---------- Presign PUT (sigue disponible) ----------
app.post('/api/presign', async (req,res)=>{
  try{
    const b=req.body||{};
    const key = cleanFolder(b.folder)+cleanName(b.filename||b.name);
    const contentType = b.contentType || 'application/octet-stream';
    const cmd = new PutObjectCommand({Bucket:R2_BUCKET, Key:key, ContentType: contentType});
    const url = await getSignedUrl(R2, cmd, { expiresIn: EXPIRES });
    res.json({ok:true, method:'PUT', url, key, contentType, expiresAt: Date.now()+EXPIRES*1000});
  }catch(e){ console.error('presign_failed', e); res.status(500).json({ok:false,error:'presign_failed'}); }
});

// ---------- Upload directo (multipart, sin OPTIONS) ----------
app.post('/api/upload-direct', upload.single('file'), async (req,res)=>{
  try{
    const filename = cleanName(req.body.filename || (req.file && req.file.originalname));
    const contentType = req.body.contentType || (req.file && req.file.mimetype) || 'application/octet-stream';
    const folder = cleanFolder(req.body.folder || '');
    const key = folder + filename;
    if(!req.file || !req.file.buffer) return res.status(400).json({ok:false,error:'No file field. Use multipart with field "file".'});
    await R2.send(new PutObjectCommand({Bucket:R2_BUCKET, Key:key, Body: req.file.buffer, ContentType: contentType}));
    res.json({ok:true, key});
  }catch(e){ console.error('upload_failed', e); res.status(500).json({ok:false,error:'upload_failed'}); }
});

// ---------- Upload directo RAW (octet-stream) ----------
app.post('/api/upload-direct-raw', express.raw({type:'application/octet-stream', limit:'200mb'}), async (req,res)=>{
  try{
    const filename = cleanName(req.query.filename || req.headers['x-file-name']);
    const contentType = req.query.contentType || req.headers['content-type'] || 'application/octet-stream';
    const folder = cleanFolder(req.query.folder || '');
    const key = folder + filename;
    if(!req.body || !req.body.length) return res.status(400).json({ok:false,error:'Empty body'});
    await R2.send(new PutObjectCommand({Bucket:R2_BUCKET, Key:key, Body: req.body, ContentType: contentType}));
    res.json({ok:true, key});
  }catch(e){ console.error('upload_failed', e); res.status(500).json({ok:false,error:'upload_failed'}); }
});

// ---------- Presign GET (descarga temporal) ----------
app.post('/api/presign-get', async (req,res)=>{
  try{
    const { key, expires } = req.body || {};
    if(!key) return res.status(400).json({ ok:false, error:'Missing key' });
    const cmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: key });
    const url = await getSignedUrl(R2, cmd, { expiresIn: Number(expires || EXPIRES) });
    res.json({ ok:true, url, key, expiresAt: Date.now() + (Number(expires||EXPIRES)*1000) });
  }catch(e){
    console.error('presign_get_failed', e);
    res.status(500).json({ ok:false, error:'presign_get_failed' });
  }
});

// ---------- Delete (borrar objeto) ----------
app.post('/api/delete', async (req,res)=>{
  try{
    const { key } = req.body || {};
    if(!key) return res.status(400).json({ ok:false, error:'Missing key' });
    await R2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    res.json({ ok:true, key });
  }catch(e){
    console.error('delete_failed', e);
    res.status(500).json({ ok:false, error:'delete_failed' });
  }
});

// ---------- Root ----------
app.get('/', (req,res)=> res.type('text/plain').send('Mixtli R2 presign + direct upload + get/delete ready'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=> console.log('Mixtli R2 v4 on :'+PORT));