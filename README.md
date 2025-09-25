# Mixtli Backend — R2 (v4)

Endpoints
- GET  /api/health
- GET  /api/config
- POST /api/presign                -> URL firmada PUT a R2 (opcional)
- POST /api/upload-direct          -> Multipart (campo `file`) sube a R2 sin OPTIONS
- POST /api/upload-direct-raw      -> Body octet-stream sube a R2 sin OPTIONS
- POST /api/presign-get            -> URL firmada de lectura (GET)
- POST /api/delete                 -> Borra objeto

ENV requeridas
- R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
- ALLOWED_ORIGINS='["https://tu-netlify","http://localhost:5173"]'
- NODE_VERSION=20, PORT=10000, PRESIGN_EXPIRES=900
- (opcional) REQUIRE_TOKEN=true y X_MIXTLI_TOKEN=...

Build: `npm ci --no-audit --no-fund || npm install --no-audit --no-fund`
Start: `node server.js`