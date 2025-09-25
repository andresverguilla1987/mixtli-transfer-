
# Mixtli Backend R2 v5.5 — Short token integrado

Endpoints clave:
- `GET /api/health`
- `GET /api/config`
- `POST /api/transfers` -> `{id}` crea paquete en memoria (`pin`, `requirePaid`)
- `POST /api/upload-direct` (multipart) -> `folder`, `filename`, `contentType`, `file`
- `GET /api/transfers/:id` lista archivos del paquete
- `POST /api/pay/create` -> JWT largo (legacy)
- `POST /api/pay/create-short` -> **token corto** `pp=<exp36>.<sig10>`
- `GET /api/transfers/:id/zip` -> acepta `?pin=...` y (si el paquete exige pago) `?pp=...` o `?paid=...` o header `x-user-plan` (bypass)

## Variables de entorno
```
R2_ACCOUNT_ID=8351c372dedf0e354a3196aff085f0ae
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=mixtli
R2_REGION=auto
R2_FORCE_PATH_STYLE=true

PAYMENT_SECRET=<hex de 32 bytes>
PAID_SHORT_TTL=86400
PLAN_BYPASS=prepaid,active
PORT=10000
```

## Inicio en Render
- Build command: `npm install`
- Start command: `node server.js`

