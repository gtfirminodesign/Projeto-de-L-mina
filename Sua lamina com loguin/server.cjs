'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const {execFile} = require('node:child_process');

const PORT = 8767;
const APP_URL = 'http://127.0.0.1:' + PORT;
const APP_ID = 'encarte-studio';
const USER_AGENT = 'EncarteStudio/1.0 (local product flyer editor)';
const SEARCH_ORIGIN = 'https://search.openfoodfacts.org';
const IMAGE_HOST = 'images.openfoodfacts.org';
const TIMEOUT_MS = 25000;
const CACHE_MS = 10 * 60 * 1000;
const ALLOWED_HOSTS = new Set(['127.0.0.1:' + PORT, 'localhost:' + PORT]);
const ALLOWED_ORIGINS = new Set(['null', APP_URL, 'http://localhost:' + PORT]);
const MIME = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf'};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = (message, status = 400, retryAfter) => Object.assign(new Error(message), {status, retryAfter});

function validateSearchQuery(value) {
  if (typeof value !== 'string') throw fail('Informe o nome do produto.');
  const query = value.trim().replace(/\s+/g, ' ');
  if (!query || query.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) throw fail('Use um nome de produto com 1 a 160 caracteres, sem caracteres de controle.');
  return query;
}

function validateImageUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('Endereço da imagem inválido.'); }
  if (url.protocol !== 'https:' || url.hostname !== IMAGE_HOST || url.port || url.username || url.password || url.hash || !/^\/images\/products\/[a-z0-9_./-]+$/i.test(url.pathname) || url.pathname.includes('//') || url.pathname.split('/').some(piece => piece === '.' || piece === '..')) {
    throw fail('Use somente fotos de produtos de images.openfoodfacts.org.');
  }
  // Do not accept encoded path segments, custom service endpoints or redirects
  // to arbitrary hosts. Query strings on genuine image URLs are harmless.
  return url;
}

function validateSearchUrl(value) {
  const url = new URL(value);
  if (url.origin !== SEARCH_ORIGIN || url.username || url.password) throw fail('O serviço retornou um redirecionamento não permitido.', 502);
  return url;
}

function fetchBuffer(url, {maxBytes, validate, deadline = Date.now() + TIMEOUT_MS, redirects = 0} = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = validate(url); } catch (error) { reject(error); return; }
    const remaining = deadline - Date.now();
    if (remaining <= 0) { reject(fail('A busca demorou demais. Tente novamente.', 504)); return; }
    const request = https.get(target, {headers: {'User-Agent': USER_AGENT, Accept: '*/*', 'Accept-Encoding': 'identity'}}, response => {
      const status = response.statusCode || 502;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume();
        clearTimeout(timer);
        if (redirects >= 2 || !response.headers.location) { reject(fail('O serviço retornou redirecionamentos demais.', 502)); return; }
        let destination;
        try { destination = validate(new URL(response.headers.location, target)); } catch { reject(fail('O serviço retornou um redirecionamento não permitido.', 502)); return; }
        fetchBuffer(destination, {maxBytes, validate, deadline, redirects: redirects + 1}).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume(); clearTimeout(timer);
        const retry = /^\d{1,5}$/.test(String(response.headers['retry-after'] || '')) ? response.headers['retry-after'] : '7';
        reject(fail(status === 429 ? 'O catálogo pediu uma pausa. Aguarde e tente novamente.' : 'O catálogo de produtos está indisponível no momento.', status === 429 ? 429 : 502, status === 429 ? retry : undefined));
        return;
      }
      if (Number(response.headers['content-length']) > maxBytes) {
        clearTimeout(timer); response.destroy(); reject(fail('A resposta do serviço excede o tamanho permitido.', 502)); return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) { response.destroy(fail('A resposta do serviço excede o tamanho permitido.', 502)); return; }
        chunks.push(chunk);
      });
      response.on('end', () => { clearTimeout(timer); resolve({body: Buffer.concat(chunks), contentType: String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase()}); });
      response.on('error', error => { clearTimeout(timer); reject(error.status ? error : fail('Não foi possível receber a imagem ou os produtos.', 502)); });
    });
    const timer = setTimeout(() => request.destroy(fail('A busca demorou demais. Tente novamente.', 504)), remaining);
    request.on('error', error => { clearTimeout(timer); reject(error.status ? error : fail('Não foi possível conectar ao catálogo. Confira sua conexão.', 502)); });
  });
}

function normalizeProducts(payload) {
  const hits = Array.isArray(payload.hits) ? payload.hits : Array.isArray(payload.products) ? payload.products : [];
  return hits.slice(0, 8).map(hit => {
    const product = hit && typeof hit === 'object' ? hit : {};
    const text = value => typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 500) : '';
    const image = value => { try { return validateImageUrl(text(value)).href; } catch { return ''; } };
    const code = text(product.code || product._id);
    return {code, product_name: text(product.product_name), product_name_pt: text(product.product_name_pt), brands: text(Array.isArray(product.brands)?product.brands.join(', '):product.brands), quantity: text(product.quantity), image_front_url: image(product.image_front_url || product.image_url), image_front_small_url: image(product.image_front_small_url || product.image_small_url || product.image_front_url), url: /^\d{4,20}$/.test(code) ? 'https://world.openfoodfacts.org/product/' + code : ''};
  }).filter(product => product.product_name || product.product_name_pt);
}

function isRaster(body, mime) {
  if (!Buffer.isBuffer(body)) return false;
  if (mime === 'image/png') return body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/jpeg') return body.length >= 3 && body[0] === 255 && body[1] === 216 && body[2] === 255;
  if (mime === 'image/webp') return body.length >= 12 && body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

async function resolveStatic(staticRoot, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { throw fail('Caminho inválido.'); }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some(piece => piece.startsWith('.'))) throw fail('Arquivo não encontrado.', 404);
  const root = await fs.promises.realpath(staticRoot);
  const candidate = path.resolve(root, '.' + (decoded === '/' ? '/index.html' : decoded));
  if (candidate !== root && !candidate.startsWith(root + path.sep)) throw fail('Arquivo não encontrado.', 404);
  const extension = path.extname(candidate).toLowerCase();
  if (!Object.hasOwn(MIME, extension)) throw fail('Arquivo não encontrado.', 404);
  let real, stat;
  try { real = await fs.promises.realpath(candidate); stat = await fs.promises.stat(real); } catch { throw fail('Arquivo não encontrado.', 404); }
  if (!real.startsWith(root + path.sep) || !stat.isFile()) throw fail('Arquivo não encontrado.', 404);
  return {filename: real, type: MIME[extension], size: stat.size};
}

function createApp({staticRoot = path.join(__dirname, fs.existsSync(path.join(__dirname, 'site')) ? 'site' : 'dist'), fetchRemote = fetchBuffer, searchIntervalMs = 7000} = {}) {
  const publishRoute=require('./publication.cjs').publication();
  const cache = new Map(), pending = new Map();
  let queue = Promise.resolve(), nextStart = 0, queued = 0;
  function search(query) {
    const key = query.toLocaleLowerCase('pt-BR');
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) return Promise.resolve(cached.value);
    if (pending.has(key)) return pending.get(key);
    if (queued >= 20) return Promise.reject(fail('Há muitas buscas em andamento. Aguarde um momento.', 429, '7'));
    queued++;
    const result = queue.then(async () => {
      await sleep(Math.max(0, nextStart - Date.now()));
      nextStart = Date.now() + searchIntervalMs;
      const url = new URL('/search', SEARCH_ORIGIN);
      url.searchParams.set('q', query);
      url.searchParams.set('page_size', '8');
      url.searchParams.set('langs', 'pt,en');
      const remote = await fetchRemote(url, {maxBytes: 1024 * 1024, validate: validateSearchUrl});
      let payload;
      try { payload = JSON.parse(remote.body.toString('utf8')); } catch { throw fail('O catálogo retornou dados inválidos. Tente novamente.', 502); }
      const value = {products: normalizeProducts(payload)};
      cache.set(key, {expires: Date.now() + CACHE_MS, value});
      if (cache.size > 100) cache.delete(cache.keys().next().value);
      return value;
    }).finally(() => { queued--; pending.delete(key); });
    queue = result.then(() => undefined, () => undefined);
    pending.set(key, result);
    return result;
  }
  return async function app(request, response) {
    function json(status, value, headers = {}) {
      if (response.destroyed || response.writableEnded) return;
      const body = JSON.stringify(value);
      response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...headers});
      response.end(body);
    }
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (!ALLOWED_HOSTS.has(String(request.headers.host || '').toLowerCase())) throw fail('Este editor só aceita conexões locais.', 403);
      const origin = request.headers.origin;
      if (origin && !ALLOWED_ORIGINS.has(origin)) throw fail('Origem não permitida.', 403);
      if (origin) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin'); }
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS', 'Access-Control-Allow-Headers':'Content-Type, X-Encarte-Publish', 'Access-Control-Max-Age': '600'}); response.end(); return;
      }
      if (await publishRoute(request,response)) return;
      if (request.method !== 'GET' && request.method !== 'HEAD') throw fail('Método não permitido.', 405);
      if (String(request.url).length > 4096) throw fail('Endereço muito longo.', 414);
      const url = new URL(request.url, APP_URL);
      if (url.origin !== APP_URL) throw fail('Endereço inválido.', 400);
      if (url.pathname.startsWith('/api/')) {
        if (request.method !== 'GET') throw fail('Use GET para acessar este recurso.', 405);
        if (url.pathname === '/api/health') { json(200, {ready: true, app: APP_ID}); return; }
        if (url.pathname === '/api/product-search') { json(200, await search(validateSearchQuery(url.searchParams.get('q')))); return; }
        if (url.pathname === '/api/product-image') {
          const target = validateImageUrl(url.searchParams.get('url'));
          const remote = await fetchRemote(target, {maxBytes: 10 * 1024 * 1024, validate: validateImageUrl});
          if (!isRaster(remote.body, remote.contentType)) throw fail('O catálogo não retornou uma foto PNG, JPEG ou WebP válida.', 502);
          if (response.destroyed || response.writableEnded) return;
          response.writeHead(200, {'Content-Type': remote.contentType, 'Content-Length': remote.body.length, 'Cache-Control': 'private, max-age=600'}); response.end(remote.body); return;
        }
        throw fail('Recurso não encontrado.', 404);
      }
      const file = await resolveStatic(staticRoot, url.pathname);
      response.writeHead(200, {'Content-Type': file.type, 'Content-Length': file.size, 'Cache-Control': 'no-cache'});
      if (request.method === 'HEAD') { response.end(); return; }
      const stream = fs.createReadStream(file.filename);
      stream.on('error', () => response.destroy());
      stream.pipe(response);
    } catch (error) {
      json(error.status || 500, {error: error.status ? error.message : 'Não foi possível concluir a operação.'}, error.retryAfter ? {'Retry-After': String(error.retryAfter)} : {});
    }
  };
}

function openBrowser() {
  const done = error => { if (error) console.log('Abra no navegador: ' + APP_URL); };
  if (process.platform === 'win32') execFile('cmd.exe', ['/d', '/c', 'start', '', APP_URL], {windowsHide: true}, done);
  else if (process.platform === 'darwin') execFile('open', [APP_URL], done);
  else execFile('xdg-open', [APP_URL], done);
}

function start() {
  const shouldOpen = process.argv.includes('--open');
  const server = http.createServer(createApp());
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.on('error', error => {
    if (error.code !== 'EADDRINUSE') { console.error('Não foi possível iniciar o editor: ' + error.message); process.exitCode = 1; return; }
    const check = http.get(APP_URL + '/api/health', response => {
      let data = '';
      response.on('data', chunk => { if (data.length < 1024) data += chunk; });
      response.on('end', () => {
        let sameApp = false;
        try { const parsed = JSON.parse(data); sameApp = response.statusCode === 200 && parsed.ready === true && parsed.app === APP_ID; } catch {}
        if (sameApp) { console.log('O Encarte Studio já está aberto em ' + APP_URL); if (shouldOpen) openBrowser(); }
        else { console.error('A porta ' + PORT + ' já está em uso por outro programa. Feche esse programa ou reinicie o computador e tente novamente.'); process.exitCode = 1; }
      });
    });
    check.setTimeout(2000, () => check.destroy());
    check.on('error', () => { console.error('A porta ' + PORT + ' já está em uso. Não foi possível confirmar o editor.'); process.exitCode = 1; });
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log('\nEncarte Studio está pronto: ' + APP_URL + '\nMantenha esta janela aberta enquanto usa o editor.\nFeche esta janela ou pressione Ctrl+C para encerrar.\n');
    if (shouldOpen) openBrowser();
  });
  return server;
}

module.exports = {createApp, validateSearchQuery, validateImageUrl, normalizeProducts, resolveStatic, isRaster, fetchBuffer, PORT, APP_URL};
if (require.main === module) start();
