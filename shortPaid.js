
import crypto from 'crypto';

const b64u = (buf) => buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const fromBase36 = (s) => parseInt(s, 36);
const toBase36 = (n) => n.toString(36);

export function signShortPaid(id, expSec, secret){
  const payload = id + '.' + toBase36(expSec);
  const mac = crypto.createHmac('sha256', secret).update(payload).digest();
  const sig10 = b64u(mac.slice(0,10));
  return toBase36(expSec) + '.' + sig10;
}

export function verifyShortPaid(id, pp, secret){
  if(!pp || typeof pp!=='string') return { ok:false, error:'invalid_pp' };
  const [exp36, sig] = pp.split('.');
  if(!exp36 || !sig) return { ok:false, error:'invalid_pp' };
  const exp = fromBase36(exp36);
  if(!Number.isFinite(exp) || exp <= 0) return { ok:false, error:'invalid_pp' };
  const now = Math.floor(Date.now()/1000);
  if(now > exp) return { ok:false, error:'expired' };
  const expected = signShortPaid(id, exp, secret);
  if(expected !== pp) return { ok:false, error:'bad_sig' };
  return { ok:true, exp };
}

export function mountShortEndpoints(app, need){
  const PAYMENT_SECRET = need('PAYMENT_SECRET');
  const SHORT_TTL = parseInt(process.env.PAID_SHORT_TTL||'86400',10);

  app.post('/api/pay/create-short', async (req,res)=>{
    try{
      const { id, amount } = req.body || {};
      if(!id) return res.status(400).json({ ok:false, error:'missing_id' });
      const exp = Math.floor(Date.now()/1000) + SHORT_TTL;
      const pp = signShortPaid(String(id), exp, PAYMENT_SECRET);
      return res.json({ ok:true, id, exp, pp });
    }catch(e){
      console.error('create-short error', e);
      res.status(500).json({ ok:false });
    }
  });
}
