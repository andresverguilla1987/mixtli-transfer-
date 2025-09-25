
# Mixtli Backend R2 v5.6 — streaming robusto + short token

- Corrige el error de proxy "non-retryable streaming request" añadiendo:
  - `res.flushHeaders()` antes de pipe
  - Manejo de `req.aborted` / `res.close` y `archive.on('warning'|'error')`
- Incluye `/api/version` para verificar la versión en vivo.

**Build:** `npm install`  
**Start:** `node server.js`  
