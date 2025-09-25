# Mixtli Backend — R2 (v5.1)

Fix: ZIP vacío resuelto — el endpoint `/api/transfers/:id/zip` ahora **bufferiza cada objeto** antes de añadirlo al ZIP, evitando streams que se cierran temprano.

Endpoints de transfers:
- `POST /api/transfers` — crea paquete `{ id, prefix, expiresAt }`
- `GET /api/transfers/:id` — lista archivos del paquete
- `GET /api/transfers/:id/zip` — descarga ZIP (corregido)
- `POST /api/transfers/:id/delete` — (no incluido en 5.1; puedes usar `POST /api/delete` por archivo o te agrego el masivo si lo necesitas)

Resto: health, config, presign(put), upload-direct, presign-get, delete.