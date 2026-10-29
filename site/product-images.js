/*
 * Encarte Studio — product image client.
 * Search/photos: Open Food Facts (image license CC BY-SA 3.0).
 * Optional AI background removal dynamically loads @imgly/background-removal
 * 1.7.0 (AGPL-3.0), https://github.com/imgly/background-removal-js.
 * No package/model is downloaded until removeBackground() is requested.
 */
(function (global) {
  'use strict';

  const HELPER_BASE = global.location?.protocol === 'file:' ? 'http://127.0.0.1:8767' : (global.location?.origin || 'http://127.0.0.1:8767');
  const IMAGE_HOST = 'images.openfoodfacts.org';
  const ATTRIBUTION = 'Open Food Facts · CC BY-SA 3.0';
  const LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/3.0/';
  const AI_MODULE = 'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm';
  const MODEL_PATH = 'https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/';
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  const cache = new Map();
  let searchQueue = Promise.resolve(), nextSearchAt = 0, aiModulePromise;

  function abortError() {
    return new DOMException('Operação cancelada.', 'AbortError');
  }
  function checkAbort(signal) {
    if (signal && signal.aborted) throw abortError();
  }
  function report(callback, value) {
    if (typeof callback === 'function') {
      try { callback(value); } catch (_) { /* UI callbacks cannot break cleanup. */ }
    }
  }
  function normalizeQuery(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/(\d),(?=\d)/g, '$1.')
      .replace(/[^a-z0-9.]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  function text(value, max = 200) {
    return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max) : '';
  }
  function safeImageURL(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === IMAGE_HOST && !url.username && !url.password && !url.port ? url.href : '';
    } catch (_) { return ''; }
  }
  function sizes(value) {
    const found = [], input = normalizeQuery(value);
    const re = /(\d+(?:\.\d+)?)\s*(quilogramas?|kilogramas?|kg|gramas?|gr|g|mililitros?|ml|litros?|lt|l)\b/g;
    let match;
    while ((match = re.exec(input))) {
      const unit = match[2], liquid = /^(mil|ml|lit|lt|l$)/.test(unit);
      const multiplier = /^(q|k|lit|lt|l$)/.test(unit) ? 1000 : 1;
      found.push((liquid ? 'ml:' : 'g:') + Number((Number(match[1]) * multiplier).toFixed(4)));
    }
    return found;
  }
  function tokens(value) {
    const ignored = new Set(['de', 'do', 'da', 'dos', 'das', 'e', 'com', 'para', 'pacote', 'caixa', 'pote', 'garrafa', 'un', 'unidade', 'unidades']);
    return [...new Set(normalizeQuery(value).replace(/(\d)([a-z])/g, '$1 $2').split(' ').filter(t => t && !ignored.has(t)))];
  }
  function matchConfidence(query, candidate) {
    const withoutSize = value => normalizeQuery(value).replace(/\b\d+(?:\.\d+)?\s*(kg|g|gr|ml|l|lt|un|unidades?)\b/g, ' ');
    const queryWords = tokens(withoutSize(query)).filter(t=>!/^\d+(?:\.\d+)?$/.test(t)), targetWords = new Set(tokens(withoutSize(candidate.name + ' ' + candidate.brands)));
    const wordMatch = queryWords.length ? queryWords.filter(t => targetWords.has(t)).length / queryWords.length : 0;
    const requestedSizes = sizes(query), candidateSizes = sizes(candidate.quantity + ' ' + candidate.name);
    let result = wordMatch;
    if (requestedSizes.length && candidateSizes.length) {
      const equalSize = requestedSizes.some(size => candidateSizes.includes(size));
      result = equalSize ? Math.min(1, wordMatch + .12) : Math.max(0, wordMatch - .3);
    }
    return Math.round(result * 100) / 100;
  }
  function wait(ms, signal) {
    checkAbort(signal);
    return new Promise((resolve, reject) => {
      let timer;
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); resolve(); };
      const aborted = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); reject(abortError()); };
      timer = setTimeout(done, Math.max(0, ms));
      signal?.addEventListener('abort', aborted, { once: true });
    });
  }
  function abortable(promise, signal) {
    checkAbort(signal);
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
      const aborted = () => { cleanup(); reject(abortError()); };
      const cleanup = () => signal.removeEventListener('abort', aborted);
      signal.addEventListener('abort', aborted, { once: true });
      promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
  }
  async function timedFetch(url, options, milliseconds, userSignal, consume) {
    checkAbort(userSignal);
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    userSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, milliseconds);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      return consume ? await consume(response) : response;
    } catch (error) {
      if (userSignal?.aborted) throw abortError();
      if (timedOut) throw new Error('A conexão demorou demais. Confira a internet e tente novamente.');
      throw error;
    } finally {
      clearTimeout(timer);
      userSignal?.removeEventListener('abort', abort);
    }
  }
  function copyCandidates(candidates) {
    return candidates.map(candidate => ({ ...candidate }));
  }
  async function search(query, { signal, onWait } = {}) {
    checkAbort(signal);
    const cleanQuery = text(String(query || ''), 160), key = normalizeQuery(cleanQuery);
    if (key.length < 2) throw new Error('Informe o nome do produto, de preferência com marca e tamanho.');
    if (cache.has(key)) return copyCandidates(cache.get(key));
    const run = searchQueue.then(async () => {
      checkAbort(signal);
      if (cache.has(key)) return copyCandidates(cache.get(key));
      while (Date.now() < nextSearchAt) {
        const remaining = nextSearchAt - Date.now();
        report(onWait, Math.ceil(remaining / 1000));
        await wait(Math.min(remaining, 1000), signal);
      }
      checkAbort(signal);
      nextSearchAt = Date.now() + 7000;
      const url = new URL('/api/product-search', HELPER_BASE);
      url.search = new URLSearchParams({ q: cleanQuery });
      let payload;
      try {
        payload = await timedFetch(url.href, { mode: 'cors', credentials: 'omit', headers: { Accept: 'application/json' } }, 45000, signal, async response => {
          if (response.status === 429) {
            const retryAfter = response.headers.get('retry-after'), seconds = Number(retryAfter);
            const resumeAt = Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : Date.parse(retryAfter || '');
            nextSearchAt = Math.max(Date.now() + 60000, Number.isFinite(resumeAt) ? resumeAt : 0);
            throw new Error('O catálogo limitou as buscas. Aguarde pelo menos 1 minuto antes de tentar novamente.');
          }
          if (response.status === 404 || response.status === 405) throw new Error('Abra Iniciar-encarte.cmd para ativar a busca de fotos.');
          if (!response.ok) throw new Error('O catálogo de imagens está indisponível (HTTP ' + response.status + '). Tente novamente mais tarde.');
          if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('Abra Iniciar-encarte.cmd para ativar a busca de fotos.');
          return response.json();
        });
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        if (error instanceof TypeError) throw new Error('Abra Iniciar-encarte.cmd para ativar a busca de fotos e confira sua conexão com a internet.');
        throw error;
      }
      checkAbort(signal);
      if (!payload || !Array.isArray(payload.products)) throw new Error('O catálogo retornou uma resposta inesperada. Tente novamente mais tarde.');
      const seen = new Set();
      const candidates = payload.products.slice(0, 20).map(product => {
        const code = text(String(product.code || ''), 30), imageUrl = safeImageURL(product.image_front_url);
        if (!/^\d{4,24}$/.test(code) || !imageUrl || seen.has(imageUrl)) return null;
        seen.add(imageUrl);
        const candidate = {
          code, name: text(product.product_name_pt) || text(product.product_name) || 'Produto sem descrição',
          brands: text(product.brands, 120), quantity: text(product.quantity, 80), imageUrl,
          thumbnailUrl: safeImageURL(product.image_front_small_url) || imageUrl,
          sourceUrl: 'https://world.openfoodfacts.org/product/' + code,
          attribution: ATTRIBUTION, license: 'CC BY-SA 3.0', licenseUrl: LICENSE_URL
        };
        candidate.confidence = matchConfidence(cleanQuery, candidate);
        candidate.matchLabel = candidate.confidence >= .8 ? 'Mais próximo da busca · confira marca e tamanho' : 'Sugestão · confira marca e tamanho';
        return candidate;
      }).filter(candidate=>candidate && candidate.confidence>=.2).sort((a, b) => b.confidence - a.confidence).slice(0, 8);
      cache.set(key, candidates);
      return copyCandidates(candidates);
    });
    searchQueue = run.then(() => undefined, () => undefined);
    return abortable(run, signal);
  }
  async function readImageBody(response) {
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(png|jpe?g|webp|avif|gif)$/.test(mime)) throw new Error('O catálogo não retornou uma imagem compatível. Escolha outra foto.');
    if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) throw new Error('A imagem ultrapassa 10 MB. Escolha outra foto.');
    if (!response.body?.getReader) {
      const blob = await response.blob();
      if (!blob.size || blob.size > MAX_IMAGE_BYTES) throw new Error('A imagem está vazia ou ultrapassa 10 MB.');
      return blob;
    }
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_IMAGE_BYTES) { await reader.cancel(); throw new Error('A imagem ultrapassa 10 MB. Escolha outra foto.'); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    if (!size) throw new Error('A imagem está vazia. Escolha outra foto.');
    return new Blob(chunks, { type: mime });
  }
  async function fetchImage(candidate, { signal } = {}) {
    const sourceURL = safeImageURL(candidate?.imageUrl);
    if (!sourceURL) throw new Error('A origem desta imagem é inválida. Faça uma nova busca.');
    const url = new URL('/api/product-image', HELPER_BASE);
    url.search = new URLSearchParams({ url: sourceURL });
    try {
      return await timedFetch(url.href, { mode: 'cors', credentials: 'omit' }, 45000, signal, async response => {
        if (!response.ok) throw new Error('Não foi possível baixar esta foto (HTTP ' + response.status + '). Escolha outra imagem.');
        if (response.url && new URL(response.url).origin !== new URL(HELPER_BASE).origin) throw new Error('A imagem foi redirecionada para uma origem não permitida.');
        return readImageBody(response);
      });
    } catch (error) {
      if (error instanceof TypeError) throw new Error('A foto não pôde ser baixada. Abra Iniciar-encarte.cmd e confira a conexão com a internet.');
      throw error;
    }
  }
  function validateBlob(blob) {
    if (!(blob instanceof Blob) || !/^image\//.test(blob.type) || !blob.size) throw new Error('Selecione uma imagem válida.');
    if (blob.size > MAX_IMAGE_BYTES) throw new Error('Use uma imagem de até 10 MB.');
  }
  async function removeBackground(blob, { signal, onProgress } = {}) {
    validateBlob(blob);
    checkAbort(signal);
    if (!global.WebAssembly) throw new Error('Este navegador não oferece suporte à remoção automática. Use uma versão atual do Chrome, Edge ou Firefox.');
    report(onProgress, { key: 'loading-library', current: 0, total: 1, ratio: 0 });
    if (!aiModulePromise) {
      aiModulePromise = import(AI_MODULE).catch(error => { aiModulePromise = undefined; throw error; });
    }
    let module;
    try { module = await abortable(aiModulePromise, signal); }
    catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error('Não foi possível carregar a remoção automática. Confira a internet ou abra o editor em uma hospedagem HTTPS. Você também pode usar “Remover fundo branco”.');
    }
    checkAbort(signal);
    const remove = module.removeBackground;
    if (typeof remove !== 'function') throw new Error('O módulo de remoção de fundo não está disponível. Tente novamente mais tarde.');
    try {
      // The SDK has no AbortSignal option. Cancellation discards its result;
      // an inference already running may finish in the background.
      const job = remove(blob, {
        model: 'isnet_quint8', device: 'cpu', proxyToWorker: false, publicPath: MODEL_PATH,
        output: { format: 'image/png', quality: 1 },
        progress: (key, current, total) => {
          if (!signal?.aborted) report(onProgress, { key, current, total, ratio: total > 0 ? Math.max(0, Math.min(1, current / total)) : 0 });
        }
      });
      const result = await abortable(Promise.resolve(job), signal);
      checkAbort(signal);
      if (!(result instanceof Blob) || result.type !== 'image/png' || !result.size) throw new Error('INVALID_OUTPUT');
      report(onProgress, { key: 'complete', current: 1, total: 1, ratio: 1 });
      return result;
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error('Não foi possível remover o fundo automaticamente. O modelo precisa de internet e memória disponível. Tente outra foto ou use “Remover fundo branco”; a imagem original não foi aplicada.');
    }
  }
  async function decode(blob, signal) {
    validateBlob(blob);
    checkAbort(signal);
    if (typeof global.createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(blob);
      if (signal?.aborted) { bitmap.close(); throw abortError(); }
      return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    }
    const url = URL.createObjectURL(blob), image = new Image();
    try {
      await abortable(new Promise((resolve, reject) => {
        image.onload = resolve; image.onerror = () => reject(new Error('Não foi possível abrir esta imagem.')); image.src = url;
      }), signal);
      return { image, width: image.naturalWidth, height: image.naturalHeight, close: () => { image.src = ''; URL.revokeObjectURL(url); } };
    } catch (error) { image.src = ''; URL.revokeObjectURL(url); throw error; }
  }
  function canvasFor(decoded, max) {
    if (!decoded.width || !decoded.height) throw new Error('A imagem tem dimensões inválidas.');
    const scale = Math.min(1, max / Math.max(decoded.width, decoded.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(decoded.width * scale));
    canvas.height = Math.max(1, Math.round(decoded.height * scale));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Este navegador não oferece suporte ao processamento de imagens.');
    context.drawImage(decoded.image, 0, 0, canvas.width, canvas.height);
    return { canvas, context };
  }
  async function resizeDataURL(blob, max = 600) {
    const decoded = await decode(blob);
    try {
      const { canvas } = canvasFor(decoded, Math.min(1600, Math.max(50, Number(max) || 600)));
      // WebP preserves alpha while keeping a full 60-photo edition compact.
      // Older engines fall back to PNG without painting an opaque background.
      return canvas.toDataURL('image/webp', .9);
    } finally { decoded.close(); }
  }
  async function quickWhiteBackground(blob, { tolerance = 30, signal } = {}) {
    const decoded = await decode(blob, signal);
    try {
      const { canvas, context } = canvasFor(decoded, 1200), { width, height } = canvas;
      const imageData = context.getImageData(0, 0, width, height), data = imageData.data;
      const threshold = 255 - Math.max(0, Math.min(90, Number(tolerance) || 0));
      const visited = new Uint8Array(width * height), queue = new Int32Array(width * height);
      let head = 0, tail = 0;
      const add = index => {
        if (visited[index]) return;
        visited[index] = 1;
        const p = index * 4;
        if (data[p + 3] === 0 || (data[p] >= threshold && data[p + 1] >= threshold && data[p + 2] >= threshold)) queue[tail++] = index;
      };
      for (let x = 0; x < width; x++) { add(x); add((height - 1) * width + x); }
      for (let y = 1; y < height - 1; y++) { add(y * width); add(y * width + width - 1); }
      while (head < tail) {
        const index = queue[head++], x = index % width;
        data[index * 4 + 3] = 0;
        if (x > 0) add(index - 1);
        if (x < width - 1) add(index + 1);
        if (index >= width) add(index - width);
        if (index < width * (height - 1)) add(index + width);
        if (head % 100000 === 0) { await wait(0, signal); checkAbort(signal); }
      }
      checkAbort(signal);
      context.putImageData(imageData, 0, 0);
      return await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Não foi possível salvar a imagem sem fundo.')), 'image/png'));
    } finally { decoded.close(); }
  }

  async function checkConnection({signal}={}) {
    try {
      return await timedFetch(new URL('/api/health',HELPER_BASE).href,{mode:'cors',credentials:'omit'},5000,signal,async response=>{
        if(!response.ok)throw Error('HELPER');
        const data=await response.json();
        if(data.app!=='encarte-studio'||!data.ready)throw Error('HELPER');
        return true;
      });
    }catch(error){
      if(error.name==='AbortError')throw error;
      throw Error('O serviço de fotos está desligado. Abra Iniciar-encarte.cmd na pasta Encarte-Studio e mantenha a janela aberta. Depois volte aqui e tente novamente. No celular, esta busca precisa de um servidor publicado; envie as fotos manualmente.');
    }
  }
  global.EncarteImages = Object.freeze({ checkConnection, search, fetchImage, removeBackground, resizeDataURL, quickWhiteBackground, normalizeQuery });
})(window);
