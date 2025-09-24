# Mixtli Backend — R2 only (v2)

Endpoints:
- `GET /api/health` → `{ ok, ts, r2Ready }`
- `GET /api/config` → echo de configuración (sin secretos)
- `POST /api/presign` → devuelve URL firmada de Cloudflare R2 (PUT)

Env requeridas:
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
- `ALLOWED_ORIGINS` (JSON array), `NODE_VERSION=20`, `PORT=10000`

Build: `npm ci --no-audit --no-fund || npm install --no-audit --no-fund`  
Start: `node server.js`