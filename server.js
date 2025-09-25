import express from 'express';
import cors from 'cors';
import multer from 'multer';
import archiver from 'archiver';
import crypto from 'crypto';
import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const app = express();
const nocache = (res)=>{ res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate'); res.setHeader('Pragma','no-cache'); res.setHeader('Expires','0'); };

// ---------- CORS ----------
let ALLOWED = ['http://localhost:5173'];
try { if (process.env.ALLOWED_ORIGINS) { const parsed = JSON.parse(process.env.ALLOWED_ORIGINS); if (Array.isArray(parsed)) ALLOWED = parsed; } } catch {}
app.use(cors({ origin: (origin, cb) => (!origin || ALLOWED.includes(origin)) ? cb(null, true) : cb(null, false) }));
app.use(express.json({ limit: '25mb' }));

// ---------- Env ----------
function need(k){const v=process.env[k]; if(!v) throw new Error('Missing env '+k); return v;}
const R2_ACCOUNT_ID = need('R2_ACCOUNT_ID');
const R2_ACCESS_KEY_ID = need('R2_ACCESS_KEY_ID');
const R2_SECRET_ACCESS_KEY = need('R2_SECRET_ACCESS_KEY');
const R2_BUCKET = need('R2_BUCKET');
const R2_REGION = process.env.R2_REGION || 'auto';
const R2_FORCE_PATH_STYLE = String(process.env.R2_FORCE_PATH_STYLE||'true').toLowerCase()==='true';
const EXPIRES = Number(process.env.PRESIGN_EXPIRES || 900);
const TRANSFER_DAYS_DEFAULT = Number(process.env.TRANSFER_DAYS_DEFAULT || 7);

const REQUIRE_TOKEN = String(process.env.REQUIRE_TOKEN||'false').toLowerCase()==='true';
const PRIVATE_TOKEN = process.env.X_MIXTLI_TOKEN || '';
const PLAN_BYPASS = (process.env.PLAN_BYPASS || 'prepaid,active').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
const PAYMENT_SECRET = need('PAYMENT_SECRET'); // for signing paid tokens

const R2 = new S3Client({
  region: R2_REGION,
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  forcePathStyle: R2_FORCE_PATH_STYLE,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY }
});

// ---------- Token middleware ----------
app.use((req,res,next)=>{
  if(!REQUIRE_TOKEN) return next();
  if(req.headers['x-mixtli-token'] !== PRIVATE_TOKEN){
    return res.status(401).json({ok:false,error:'x-mixtli-token required'});
  }
  next();
});

const upload = multer();

// ---------- Utils ----------
function cleanName(s){ return String(s||'file.bin').replace(/[^a-zA-Z0-9_\-.]/g,'_').slice(0,200); }
function cleanFolder(s){ const x = String(s||'').replace(/^\/+|\/+$/g,'').replace(/[^a-zA-Z0-9_\-/]/g,'_'); return x? x+'/' : ''; }
const transferPrefix = id => `transfers/${id}/`;
const randomId = (n=7)=>{ const s='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let out=''; for(let i=0;i<n;i++) out+=s[Math.floor(Math.random()*s.length)]; return out; };
const isValidId = id => /^[A-Z2-9_\-]{5,20}$/.test(id);
const b64url = (buf)=> Buffer.from(buf).toString('base64').replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
const sign = (payloadObj)=>{
  const header = b64url(JSON.stringify({alg:'HS256',typ:'JWT'}));
  const payload = b64url(JSON.stringify(payloadObj));
  const mac = crypto.createHmac('sha256', PAYMENT_SECRET).update(header+'.'+payload).digest('base64').replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
  return header+'.'+payload+'.'+mac;
};
const verify = (token)=>{
  try{
    const [h,p,s] = token.split('.'); if(!h||!p||!s) return null;
    const mac = crypto.createHmac('sha256', PAYMENT_SECRET).update(h+'.'+p).digest('base64').replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
    if(mac!==s) return null;
    const payload = JSON.parse(Buffer.from(p.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf-8'));
    if(payload.exp && Date.now() > payload.exp) return null;
    return payload;
  }catch{ return null; }
};

async function loadMeta(id){
  const cmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: `transfers/${id}/_meta.json` });
  try{
    const r = await R2.send(cmd);
    const chunks=[]; for await (const c of r.Body) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  }catch(e){ return null; }
}

// ---------- Health & Config ----------
app.get('/api/health', (req,res)=>{ nocache(res); res.json({ok:true, ts:Date.now()}); });
app.get('/api/config', (req,res)=>{ nocache(res); res.json({ ok:true, bucket:R2_BUCKET, accountId:R2_ACCOUNT_ID.slice(0,6)+'…', allowedOrigins:ALLOWED, expires:EXPIRES, transferDaysDefault: TRANSFER_DAYS_DEFAULT, planBypass: PLAN_BYPASS, hasPaymentSecret: !!PAYMENT_SECRET }); });

// ---------- Presign PUT ----------
app.post('/api/presign', async (req,res)=>{
  try{
    const b=req.body||{};
    const key = cleanFolder(b.folder)+cleanName(b.filename||b.name);
    const contentType = b.contentType || 'application/octet-stream';
    const cmd = new PutObjectCommand({Bucket:R2_BUCKET, Key:key, ContentType: contentType});
    const url = await getSignedUrl(R2, cmd, { expiresIn: EXPIRES });
    nocache(res);
    res.json({ok:true, method:'PUT', url, key, contentType, expiresAt: Date.now()+EXPIRES*1000});
  }catch(e){ console.error('presign_failed', e); res.status(500).json({ok:false,error:'presign_failed'}); }
});

// ---------- Upload directo (multipart) ----------
app.post('/api/upload-direct', upload.single('file'), async (req,res)=>{
  try{
    const filename = cleanName(req.body.filename || (req.file && req.file.originalname));
    const contentType = req.body.contentType || (req.file && req.file.mimetype) || 'application/octet-stream';
    const folder = cleanFolder(req.body.folder || '');
    const key = folder + filename;
    if(!req.file || !req.file.buffer) return res.status(400).json({ok:false,error:'No file field. Use multipart with field "file".'});
    await R2.send(new PutObjectCommand({Bucket:R2_BUCKET, Key:key, Body: req.file.buffer, ContentType: contentType}));
    nocache(res);
    res.json({ok:true, key});
  }catch(e){ console.error('upload_failed', e); res.status(500).json({ok:false,error:'upload_failed'}); }
});

// ---------- Presign GET & Delete ----------
app.post('/api/presign-get', async (req,res)=>{
  try{
    const { key, expires } = req.body || {};
    if(!key) return res.status(400).json({ ok:false, error:'Missing key' });
    const cmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: key });
    const url = await getSignedUrl(R2, cmd, { expiresIn: Number(expires || EXPIRES) });
    nocache(res);
    res.json({ ok:true, url, key, expiresAt: Date.now() + (Number(expires||EXPIRES)*1000) });
  }catch(e){ console.error('presign_get_failed', e); res.status(500).json({ ok:false, error:'presign_get_failed' }); }
});
app.post('/api/delete', async (req,res)=>{
  try{ const { key } = req.body || {}; if(!key) return res.status(400).json({ ok:false, error:'Missing key' });
    await R2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    nocache(res);
    res.json({ ok:true, key });
  }catch(e){ console.error('delete_failed', e); res.status(500).json({ ok:false, error:'delete_failed' }); }
});

// ================= Transfers =================
app.post('/api/transfers', async (req,res)=>{
  try{
    const randomId = (n=7)=>{ const s='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let out=''; for(let i=0;i<n;i++) out+=s[Math.floor(Math.random()*s.length)]; return out; };
    const isValidId = id => /^[A-Z2-9_\-]{5,20}$/.test(id);
    let id = (req.body?.id && String(req.body.id).toUpperCase()) || randomId(7);
    id = id.toUpperCase().replace(/[^A-Z0-9_\-]/g,'');
    if(!isValidId(id)) id = randomId(7);
    const days = Number(req.body?.days || TRANSFER_DAYS_DEFAULT);
    const expiresAt = Date.now() + days*24*3600*1000;

    const pin = (req.body?.pin && String(req.body.pin).slice(0,12)) || null;
    const requirePaid = Boolean(req.body?.requirePaid);

    const meta = { id, days, expiresAt, pin, requirePaid };
    await R2.send(new PutObjectCommand({ Bucket:R2_BUCKET, Key: `transfers/${id}/_meta.json`, Body: Buffer.from(JSON.stringify(meta)), ContentType: 'application/json' }));
    nocache(res);
    res.json({ ok:true, id, prefix: `transfers/${id}/`, expiresAt, pin: !!pin, requirePaid });
  }catch(e){ console.error('transfer_create_failed', e); res.status(500).json({ ok:false, error:'transfer_create_failed' }); }
});

async function listKeys(prefix){
  let ContinuationToken; const keys=[];
  while(true){
    const r = await R2.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: prefix, ContinuationToken }));
    (r.Contents||[]).forEach(o=>{
      if(o.Key.endsWith('/_meta.json')) return;
      if(o.Key === prefix) return;
      if(o.Key.endsWith('/')) return;
      keys.push(o.Key);
    });
    if(!r.IsTruncated) break;
    ContinuationToken = r.NextContinuationToken;
  }
  return keys;
}

app.get('/api/transfers/:id', async (req,res)=>{
  try{
    const id = String(req.params.id).toUpperCase();
    if(!isValidId(id)) return res.status(400).json({ ok:false, error:'invalid_id' });
    const prefix = `transfers/${id}/`;
    const keys = await listKeys(prefix);
    const items = keys.map(k=>({ key:k.replace(prefix,''), size:null, lastModified:null }));
    const meta = await loadMeta(id);
    nocache(res);
    res.json({ ok:true, id, prefix, items, meta });
  }catch(e){ console.error('transfer_list_failed', e); res.status(500).json({ ok:false, error:'transfer_list_failed' }); }
});

// ---------- Payment helpers ----------
app.post('/api/pay/create', async (req,res)=>{
  try{
    const { id, amount } = req.body || {};
    if(!id || !isValidId(id)) return res.status(400).json({ ok:false, error:'invalid_id' });
    const meta = await loadMeta(id);
    if(!meta) return res.status(404).json({ ok:false, error:'not_found' });
    const exp = Date.now() + 60*60*1000; // 1h
    const token = sign({ sub:'zip', id, amount: Number(amount||0), exp });
    nocache(res);
    res.json({ ok:true, transferId:id, amount: Number(amount||0), token });
  }catch(e){ console.error('pay_create_failed', e); res.status(500).json({ ok:false, error:'pay_create_failed' }); }
});

app.post('/api/pay/verify', async (req,res)=>{
  try{
    const { token } = req.body || {};
    const payload = token && verify(token);
    if(!payload) return res.status(400).json({ ok:false, error:'invalid_token' });
    nocache(res);
    res.json({ ok:true, payload });
  }catch(e){ console.error('pay_verify_failed', e); res.status(500).json({ ok:false, error:'pay_verify_failed' }); }
});

// ZIP with PIN + Plan bypass + Paid token
app.get('/api/transfers/:id/zip', async (req,res)=>{
  try{
    const id = String(req.params.id).toUpperCase();
    if(!isValidId(id)) return res.status(400).send('invalid_id');
    const meta = await loadMeta(id) || {};

    if(meta.pin){
      const pinHdr = req.headers['x-transfer-pin'];
      const pinQ = (req.query.pin||'').toString();
      if(pinHdr !== meta.pin && pinQ !== meta.pin){
        return res.status(401).json({ ok:false, error:'pin_required' });
      }
    }
    const userPlan = (req.headers['x-user-plan']||'').toString().toLowerCase();
    const isBypass = !!userPlan && PLAN_BYPASS.includes(userPlan);
    if(meta.requirePaid && !isBypass){
      const paid = (req.query.paid||'').toString();
      const payload = paid && verify(paid);
      if(!payload || payload.id !== id){ return res.status(402).json({ ok:false, error:'payment_required' }); }
    }

    const prefix = `transfers/${id}/`;
    const keys = await listKeys(prefix);
    if(keys.length===0) { nocache(res); return res.status(404).send('Transfer vacío'); }

    res.setHeader('Content-Type','application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="transfer_${id}.zip"`);
    res.setHeader('Cache-Control','no-store');
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => { console.error('zip_error', err); if(!res.headersSent) res.status(500).end(); });
    archive.pipe(res);
    for(const k of keys){
      const obj = await R2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: k }));
      const chunks=[]; for await (const c of obj.Body) chunks.push(c);
      const buf = Buffer.concat(chunks);
      archive.append(buf, { name: k.replace(prefix,'') });
    }
    await archive.finalize();
  }catch(e){ console.error('transfer_zip_failed', e); if(!res.headersSent) res.status(500).send('zip_failed'); }
});

app.get('/', (req,res)=> res.type('text/plain').send('Mixtli R2 v5.4 — Signed paid tokens + PIN + plan bypass'));
const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=> console.log('Mixtli R2 v5.4 on :'+PORT));