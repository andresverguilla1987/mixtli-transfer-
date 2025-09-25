
# Mixtli Backend — Short Paid Token Patch

Convierte los enlaces largos `?paid=<JWT>` en cortos `?pp=<exp36>.<sig10>`.

## Integración
1) Copia `shortPaid.js` a tu repo (por ejemplo `src/shortPaid.js`).
2) En `server.js`:
```js
import { mountShortEndpoints, verifyShortPaid } from './src/shortPaid.js';
mountShortEndpoints(app, need);
```
3) En el handler ZIP acepta `pp`:
```js
const id = req.params.id;
if (requirePaid) {
  const pp = req.query.pp ? String(req.query.pp) : null;
  const paidJwt = req.query.paid ? String(req.query.paid) : null;
  const bypass = /* tu header x-user-plan */;

  if (pp) {
    const v = verifyShortPaid(id, pp, need('PAYMENT_SECRET'));
    if (!v.ok) return res.status(402).json({ ok:false, error:'payment_required', detail:v });
  } else if (paidJwt) {
    // verificación JWT existente
  } else if (!bypass) {
    return res.status(402).json({ ok:false, error:'payment_required' });
  }
}
```
4) TTL corto (default 24h): `PAID_SHORT_TTL=86400`.
