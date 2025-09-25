
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import Busboy from 'busboy';
import archiver from 'archiver';

function need(k){ const v=process.env[k]; if(!v) throw new Error('Missing env '+k); return v; }
function b64u(buf){ return Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function randId(n=6){ const abc='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s=''; for(let i=0;i<n;i++){ s+=abc[Math.floor(Math.random()*abc.length)]; } return s; }
const toBase36 = n => n.toString(36);
const fromBase36 = s => parseInt(s, 36);

const VERSION = 'Mixtli R2 v5.6';

const R2_ENDPOINT = `https://${need('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`;
const s3 = new S3Client({
  region: process.env.R2_REGION || 'auto',
  endpoint: R2_ENDPOINT,
  forcePathStyle: process.env.R2_FORCE_PATH_STYLE === 'true',
  credentials: { accessKeyId: need('R2_ACCESS_KEY_ID'), secretAccessKey: need('R2_SECRET_ACCESS_KEY') }
});
const BUCKET = need('R2_BUCKET');

const PAYMENT_SECRET = need('PAYMENT_SECRET');
const SHORT_TTL = parseInt(process.env.PAID_SHORT_TTL||'86400',10);
const PLAN_BYPASS = (process.env.PLAN_BYPASS||'').split(',').map(s=>s.trim()).filter(Boolean);

const store = new Map();

function signShortPaid(id, expSec){
  const payload = id + '.' + toBase36(expSec);
  const sig10 = b64u(crypto.createHmac('sha256', PAYMENT_SECRET).update(payload).digest().slice(0,10));
  return toBase36(expSec) + '.' + sig10;
}
function verifyShortPaid(id, pp){
  if(!pp) return {ok:false,error:'invalid_pp'};
  const [exp36,sig]=pp.split('.'); if(!exp36||!sig) return {ok:false,error:'invalid_pp'};
  const exp = fromBase36(exp36); if(!Number.isFinite(exp)||exp<=0) return {ok:false,error:'invalid_pp'};
  if(Math.floor(Date.now()/1000)>exp) return {ok:false,error:'expired'};
  const expected = signShortPaid(id, exp);
  return expected===pp ? {ok:true,exp} : {ok:false,error:'bad_sig'};
}
function signJWT(obj, expSec){
  const h=b64u(JSON.stringify({alg:'HS256',typ:'JWT'}));
  const p=b64u(JSON.stringify({...obj,exp:expSec}));
  const s=b64u(crypto.createHmac('sha256', PAYMENT_SECRET).update(h+'.'+p).digest());
  return h+'.'+p+'.'+s;
}
function verifyJWT(t){
  try{
    const [h,p,s]=t.split('.'); const data=h+'.'+p;
    const expSig=b64u(crypto.createHmac('sha256', PAYMENT_SECRET).update(data).digest());
    if(expSig!==s) return {ok:false,error:'bad_sig'};
    const payload=JSON.parse(Buffer.from(p.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString());
    if(payload.exp && Math.floor(Date.now()/1000)>payload.exp) return {ok:false,error:'expired'};
    return {ok:true,payload};
  }catch{ return {ok:false,error:'invalid_jwt'}; }
}

const app = express();
app.use(cors());
app.use(express.json({limit:'2mb'}));

app.get('/', (req,res)=> res.status(200).send(VERSION));
app.get('/api/version', (req,res)=> res.json({ok:true, version: VERSION}));
app.get('/api/health', (req,res)=> res.json({ok:true, ts:Date.now(), r2Ready:true}));
app.get('/api/config', (req,res)=> res.json({ok:true, hasPaymentSecret:!!PAYMENT_SECRET, paidShortTTL:SHORT_TTL, bypassPlans:PLAN_BYPASS }));

app.post('/api/transfers', (req,res)=>{
  const { pin, requirePaid } = req.body || {};
  const id = randId(6);
  store.set(id, { pin: pin || null, requirePaid: !!requirePaid });
  res.json({ ok:true, id });
});

app.get('/api/transfers/:id', async (req,res)=>{
  const id=req.params.id; const Prefix=`transfers/${id}/`;
  const out=await s3.send(new ListObjectsV2Command({Bucket:BUCKET,Prefix}));
  const items=(out.Contents||[]).filter(x=>x.Key!==Prefix).map(x=>({key:x.Key.replace(Prefix,''),size:x.Size}));
  res.json({ok:true,id,items});
});

app.post('/api/upload-direct', (req,res)=>{
  const busboy = Busboy({ headers: req.headers });
  const fields={}; let uploaded=false; let fileErr=null;
  busboy.on('field',(n,v)=>fields[n]=v);
  busboy.on('file',(n,file,info)=>{
    const filename=fields.filename||info.filename||'file.bin';
    const contentType=fields.contentType||info.mimeType||'application/octet-stream';
    const folder=(fields.folder||'uploads').replace(/^\/*/,'').replace(/\.\./g,'');
    const key=`${folder}/${filename}`;
    s3.send(new PutObjectCommand({Bucket:BUCKET,Key:key,Body:file,ContentType:contentType}))
      .then(()=>{uploaded=true})
      .catch(err=>{fileErr=err});
  });
  busboy.on('close',()=>{
    if(fileErr) return res.status(500).json({ok:false,error:'upload_failed'});
    if(!uploaded) return res.status(400).json({ok:false,error:'no_file'});
    res.json({ok:true});
  });
  req.pipe(busboy);
});

app.post('/api/pay/create', (req,res)=>{
  const { id, amount } = req.body || {}; if(!id) return res.status(400).json({ok:false,error:'missing_id'});
  const exp=Math.floor(Date.now()/1000)+SHORT_TTL; const token=signJWT({id,amount},exp);
  res.json({ok:true,id,token,exp});
});
app.post('/api/pay/create-short', (req,res)=>{
  const { id, amount } = req.body || {}; if(!id) return res.status(400).json({ok:false,error:'missing_id'});
  const exp=Math.floor(Date.now()/1000)+SHORT_TTL; const pp=signShortPaid(String(id),exp);
  res.json({ok:true,id,pp,exp});
});

app.get('/api/transfers/:id/zip', async (req,res)=>{
  const id=req.params.id;
  const meta=store.get(id)||{pin:null,requirePaid:false};

  if(meta.pin){
    const pin=(req.query.pin||'').toString();
    if(pin!==meta.pin) return res.status(401).json({ok:false,error:'pin_required'});
  }

  if(meta.requirePaid===true){
    const plan=(req.headers['x-user-plan']||'').toString();
    const bypass=PLAN_BYPASS.includes(plan);
    const pp=req.query.pp?String(req.query.pp):null;
    const paidJwt=req.query.paid?String(req.query.paid):null;
    let allowed=bypass;
    if(!allowed && pp){ const v=verifyShortPaid(id,pp); if(v.ok) allowed=true; }
    if(!allowed && paidJwt){ const v=verifyJWT(paidJwt); if(v.ok && v.payload?.id===id) allowed=true; }
    if(!allowed) return res.status(402).json({ok:false,error:'payment_required'});
  }

  const Prefix=`transfers/${id}/`;
  const listed=await s3.send(new ListObjectsV2Command({Bucket:BUCKET,Prefix}));
  const items=(listed.Contents||[]).filter(x=>x.Key!==Prefix);
  if(items.length===0) return res.status(404).json({ok:false,error:'empty_package'});

  res.setHeader('Content-Type','application/zip');
  res.setHeader('Content-Disposition',`attachment; filename="${id}.zip"`);
  // flush headers early to avoid proxy buffering issues
  if (res.flushHeaders) res.flushHeaders();

  const archive=archiver('zip',{zlib:{level:9}});
  archive.on('warning',err=>{ console.warn('archiver warning',err?.message); });
  archive.on('error',err=>{ console.error('archiver error',err?.message); try{ res.status(500).end(); }catch{} });

  // Abort if client disconnects (Render proxies can cut the stream)
  let aborted=false;
  req.on('aborted',()=>{ aborted=true; try{ archive.destroy(); }catch{} });
  res.on('close',()=>{ if(!res.writableEnded){ try{ archive.destroy(); }catch{} } });

  archive.pipe(res);
  for(const obj of items){
    if(aborted) break;
    const rel=obj.Key.replace(Prefix,'');
    const get=await s3.send(new GetObjectCommand({Bucket:BUCKET,Key:obj.Key}));
    archive.append(get.Body, { name: rel });
  }
  try{ await archive.finalize(); }catch{ /* handled above */ }
});

const PORT=process.env.PORT||10000;
app.listen(PORT,()=>console.log(VERSION+' on :'+PORT));
