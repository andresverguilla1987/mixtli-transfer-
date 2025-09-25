# Mixtli Backend — R2 (v5, transfers)

Nuevos endpoints (paquetes estilo WeTransfer):
- `POST /api/transfers` → crea paquete `{ id, prefix, expiresAt }` (por defecto 7 días, `TRANSFER_DAYS_DEFAULT`).
- `GET /api/transfers/:id` → lista archivos dentro del paquete.
- `GET /api/transfers/:id/zip` → descarga ZIP (streaming) con todo el paquete.
- `POST /api/transfers/:id/delete` → borra todo el paquete.

Sube archivos usando `folder = transfers/<id>` con:
- `POST /api/upload-direct` (multipart) o
- `POST /api/presign` + PUT (si tu bucket permite OPTIONS).

Resto de endpoints existentes:
- health, config, presign (PUT), upload-direct, upload-direct-raw, presign-get, delete.