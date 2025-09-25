
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import Busboy from 'busboy';
import archiver from 'archiver';

// ---------- helpers ----------
function need(k){ const v=process.env[k]; if(!v) throw new Error('Missing env '+k); return v; }
function b64u(buf){ return Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function randId(n=6){ const abc='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s=''; for(let i=0;i<n;i++){ s+=abc[Math.floor(Math.random()*abc.length)]; } return s; }
const toBase36 = n => n.toString(36);
const fromBase36 = s => parseInt(s, 36);

// ---------- R2 (S3 compat) ----------
const R2_ENDPOINT = `https://${need('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`;
const s3 = new S3Client({
  region: process.env.R2_REGION || 'auto',
  endpoint: R2_ENDPOINT,
  forcePathStyle: process.env.R2_FORCE_PATH_STYLE === 'true',
  credentials: {
    accessKeyId: need('R2_ACCESS_KEY_ID'),
    secretAccessKey: need('R2_SECRET_ACCESS_KEY')
  }
});
const BUCKET = need('R2_BUCKET');

// ---------- payment secrets ----------
const PAYMENT_SECRET = need('PAYMENT_SECRET');
const SHORT_TTL = parseInt(process.env.PAID_SHORT_TTL||'86400',10); // 24h
const PLAN_BYPASS = (process.env.PLAN_BYPASS||'').split(',').map(s=>s.trim()).filter(Boolean);

// in-memory store (per deploy) for pin/requirePaid
const store = new Map(); // id -> { pin, requirePaid }

// sign short token: exp36.sig10
function signShortPaid(id, expSec){
  const payload = id + '.' + toBase36(expSec);
  const mac = crypto.createHmac('sha256', PAYMENT_SECRET).update(payload).digest();
  const sig10 = b64u(mac.slice(0,10));
  return toBase36(expSec) + '.' + sig10;
}
function verifyShortPaid(id, pp){
  if(!pp || typeof pp!=='string') return { ok:false, error:'invalid_pp' };
  const [exp36, sig] = pp.split('.');
  if(!exp36 || !sig) return { ok:false, error:'invalid_pp' };
  const exp = fromBase36(exp36);
  if(!Number.isFinite(exp) || exp <= 0) return { ok:false, error:'invalid_pp' };
  const now = Math.floor(Date.now()/1000);
  if(now > exp) return { ok:false, error:'expired' };
  const expected = signShortPaid(id, exp);
  if(expected !== pp) return { ok:false, error:'bad_sig' };
  return { ok:true, exp };
}

// very small HS256 JWT for legacy `paid=`
function signJWT(obj, expSec){
  const header = b64u(JSON.stringify({alg:'HS256',typ:'JWT'}));
  const payload = b64u(JSON.stringify({...obj, exp: expSec}));
  const data = header+'.'+payload;
  const sig = b64u(crypto.createHmac('sha256', PAYMENT_SECRET).update(data).digest());
  return data+'.'+sig;
}
function verifyJWT(token){
  try{
    const [h,p,s]=token.split('.');
    const data=h+'.'+p;
    const expSig = b64u(crypto.createHmac('sha256', PAYMENT_SECRET).update(data).digest());
    if(expSig!==s) return {ok:false,error:'bad_sig'};
    const payload=JSON.parse(Buffer.from(p.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString());
    const now=Math.floor(Date.now()/1000);
    if(payload.exp && now>payload.exp) return {ok:false,error:'expired'};
    return {ok:true,payload};
  }catch(e){ return {ok:false,error:'invalid_jwt'}; }
}

// ---------- app ----------
const app = express();
app.use(cors());
app.use(express.json({limit:'2mb'}));

app.get('/', (req,res)=> res.status(200).send('Mixtli R2 v5.5'));

app.get('/api/health', (req,res)=>{
  res.json({ok:true, ts: Date.now(), r2Ready: true});
});

app.get('/api/config', (req,res)=>{
  res.json({
    ok:true,
    hasPaymentSecret: !!PAYMENT_SECRET,
    paidShortTTL: SHORT_TTL,
    bypassPlans: PLAN_BYPASS
  });
});

// create transfer
app.post('/api/transfers', (req,res)=>{
  const { pin, requirePaid } = req.body || {};
  const id = randId(6);
  store.set(id, { pin: pin || null, requirePaid: !!requirePaid });
  res.json({ ok:true, id });
});

// list items
app.get('/api/transfers/:id', async (req,res)=>{
  const id = req.params.id;
  const Prefix = `transfers/${id}/`;
  const cmd = new ListObjectsV2Command({ Bucket: BUCKET, Prefix });
  const out = await s3.send(cmd);
  const items = (out.Contents||[]).filter(x=>x.Key!==Prefix).map(x=>({ key: x.Key.replace(Prefix,''), size: x.Size }));
  res.json({ ok:true, id, items });
});

// upload-direct (multipart)
app.post('/api/upload-direct', (req,res)=>{
  const busboy = Busboy({ headers: req.headers });
  const fields = {};
  let uploaded = false;
  let fileErr = null;

  busboy.on('field', (name, val) => { fields[name]=val; });
  busboy.on('file', (name, file, info) => {
    const filename = fields.filename || info.filename || 'file.bin';
    const contentType = fields.contentType || info.mimeType || 'application/octet-stream';
    const folder = (fields.folder||'uploads').replace(/^\/*/,'').replace(/\.\./g,'');
    const key = `${folder}/${filename}`;
    const put = new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: file, ContentType: contentType });
    s3.send(put).then(()=>{
      uploaded = true;
    }).catch(err=>{
      fileErr = err;
    });
  });
  busboy.on('close', ()=>{
    if(fileErr) return res.status(500).json({ ok:false, error:'upload_failed' });
    if(!uploaded) return res.status(400).json({ ok:false, error:'no_file' });
    res.json({ ok:true });
  });
  req.pipe(busboy);
});

// payments
app.post('/api/pay/create', (req,res)=>{
  const { id, amount } = req.body || {};
  if(!id) return res.status(400).json({ ok:false, error:'missing_id' });
  const exp = Math.floor(Date.now()/1000) + SHORT_TTL;
  const token = signJWT({ id, amount }, exp);
  res.json({ ok:true, id, token, exp });
});
app.post('/api/pay/create-short', (req,res)=>{
  const { id, amount } = req.body || {};
  if(!id) return res.status(400).json({ ok:false, error:'missing_id' });
  const exp = Math.floor(Date.now()/1000) + SHORT_TTL;
  const pp = signShortPaid(String(id), exp);
  res.json({ ok:true, id, pp, exp });
});

// download zip
app.get('/api/transfers/:id/zip', async (req,res)=>{
  const id = req.params.id;
  const meta = store.get(id) || { pin:null, requirePaid:false };

  // check pin if set
  if(meta.pin){
    const pin = (req.query.pin||'').toString();
    if(pin !== meta.pin) return res.status(401).json({ ok:false, error:'pin_required' });
  }

  // payment enforcement
  const requirePaid = meta.requirePaid === true;
  if(requirePaid){
    const plan = (req.headers['x-user-plan']||'').toString();
    const bypass = PLAN_BYPASS.includes(plan);
    const pp = req.query.pp ? String(req.query.pp) : null;
    const paidJwt = req.query.paid ? String(req.query.paid) : null;

    let allowed = bypass;
    if(!allowed && pp){
      const v = verifyShortPaid(id, pp);
      if(v.ok) allowed = true;
    }
    if(!allowed && paidJwt){
      const v = verifyJWT(paidJwt);
      if(v.ok && v.payload?.id === id) allowed = true;
    }
    if(!allowed){
      return res.status(402).json({ ok:false, error:'payment_required' });
    }
  }

  // stream zip
  const Prefix = `transfers/${id}/`;
  const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix }));
  const items = (list.Contents||[]).filter(x=>x.Key!==Prefix);
  if(items.length===0){
    return res.status(404).json({ ok:false, error:'empty_package' });
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${id}.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => { try{ res.status(500).end(); }catch{} });
  archive.pipe(res);

  for(const obj of items){
    const rel = obj.Key.replace(Prefix,'');
    const get = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: obj.Key }));
    archive.append(get.Body, { name: rel });
  }
  archive.finalize();
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=>{
  console.log(`Mixtli R2 v5.5 on :${PORT}`);
});
