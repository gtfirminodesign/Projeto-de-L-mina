/* EncarteList: deterministic import of user supplied names, prices and club flags. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EncarteList = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const clean = value => String(value == null ? '' : value).replace(/^\uFEFF/, '').trim();
  const key = value => clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[?:]/g, '').replace(/\s+/g, ' ');
  const yes = new Set(['sim', 's', 'clube', 'do clube', 'oferta clube', 'exclusivo clube', 'true', '1']);
  const no = new Set(['', 'nao', 'n', 'normal', 'false', '0', 'sem clube', 'nao clube', 'nao e clube', 'todos']);

  function parseClub(value) {
    const normalized = key(value);
    return yes.has(normalized) ? true : no.has(normalized) ? false : null;
  }

  function parsePrice(value) {
    let source = clean(value).replace(/^R\$\s*/i, '').trim();
    if (!source || /\s/.test(source)) return null;
    if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(source)) source = source.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(?:,\d{3})+\.\d{1,2}$/.test(source)) source = source.replace(/,/g, '');
    else if (/^\d+(?:[.,]\d{1,2})?$/.test(source)) source = source.replace(',', '.');
    else return null;
    const number = Number(source);
    return Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER / 100 ? number : null;
  }

  // A quoted CSV field may span lines. Report the original starting line.
  function recordsFrom(text) {
    const records = [];
    const source = String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
    let start = 1, line = 1, record = '', quoted = false, fieldStart = true;
    for (let i = 0; i < source.length; i++) {
      const c = source[i];
      if (c === '"') {
        if (quoted && source[i + 1] === '"') { record += '""'; i++; continue; }
        if (quoted) quoted = false;
        else if (fieldStart) quoted = true;
        fieldStart = false;
      } else if (c === '\n') {
        if (!quoted) {
          records.push({text: record, line: start});
          record = ''; line++; start = line; fieldStart = true; continue;
        }
        line++;
      } else if (!quoted && /[;,\t]/.test(c)) fieldStart = true;
      else if (!/\s/.test(c)) fieldStart = false;
      record += c;
    }
    if (record.trim() || quoted) records.push({text: record, line: start, unclosed: quoted});
    return records;
  }

  function outsideQuotes(text) {
    let result = '', quoted = false, fieldStart = true;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
        if (quoted && text[i + 1] === '"') { result += '  '; i++; continue; }
        if (quoted) quoted = false;
        else if (fieldStart) quoted = true;
        fieldStart = false;
        result += ' ';
      } else {
        result += quoted ? ' ' : c;
        if (!quoted && /[;,\t]/.test(c)) fieldStart = true;
        else if (!/\s/.test(c)) fieldStart = false;
      }
    }
    return result;
  }

  function splitDelimited(text, delimiter) {
    const fields = [];
    let field = '', quoted = false, closed = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') { quoted = false; closed = true; }
        else field += c;
      } else if (c === delimiter) {
        fields.push(clean(field)); field = ''; closed = false;
      } else if (c === '"' && !field.trim() && !closed) quoted = true;
      else if (closed && !/\s/.test(c)) throw new Error('Há texto depois de uma aspa fechada. Confira as colunas da lista.');
      else field += c;
    }
    if (quoted) throw new Error('Faltou fechar uma aspa nesta linha.');
    fields.push(clean(field));
    return fields;
  }

  function columns(text) {
    const outside = outsideQuotes(text);
    if (outside.includes('\t')) return {values: splitDelimited(text, '\t'), delimiter: '\t'};
    if (outside.includes(';')) return {values: splitDelimited(text, ';'), delimiter: ';'};
    // Whitespace around a dash keeps hyphenated brands and product names intact.
    if (/\s[—–-]\s/.test(outside)) {
      const pieces = [], pattern = /\s+[—–-]\s+/g;
      let start = 0, match;
      while ((match = pattern.exec(outside))) { pieces.push(clean(text.slice(start, match.index))); start = pattern.lastIndex; }
      pieces.push(clean(text.slice(start)));
      return {values: pieces, delimiter: 'dash'};
    }
    if (outside.includes(',')) {
      // A currency prefix also permits "Produto R$ 12,99" without mistaking
      // its decimal comma for a CSV separator.
      if (/\s+R\$\s*\d/.test(outside) && !outside.slice(0, outside.search(/\s+R\$/)).includes(',')) return currencyColumns(text);
      return {values: splitDelimited(text, ','), delimiter: ','};
    }
    if (/\s+R\$\s*\d/.test(outside)) return currencyColumns(text);
    return {values: [clean(text)], delimiter: ''};
  }

  function currencyColumns(text) {
    const match = text.match(/^(.*?)\s+(R\$\s*[\d.,]+)(?:\s+(.+))?\s*$/i);
    return match ? {values: [clean(match[1]), clean(match[2]), clean(match[3])], delimiter: 'currency'} : {values: [clean(text)], delimiter: ''};
  }

  function headerFor(values) {
    const names = ['produto', 'nome', 'nome do produto', 'item', 'descricao do produto'];
    const prices = ['preco', 'valor', 'preco r$', 'valor r$', 'preco (r$)', 'valor (r$)', 'preco de venda', 'valor de venda'];
    const clubs = ['clube', 'do clube', 'e do clube', 'oferta clube', 'preco clube', 'exclusivo clube'];
    const normalized = values.map(key);
    let name = normalized.findIndex(value => names.includes(value));
    if (name < 0) name = normalized.indexOf('descricao');
    const price = normalized.findIndex(value => prices.includes(value));
    if (name < 0 || price < 0) return null;
    const club = normalized.findIndex(value => clubs.includes(value));
    return {name, price, club, length: values.length};
  }

  function sizeDescription(name) {
    const matches = name.match(/\b\d+(?:[.,]\d+)?\s*(?:kg|mg|ml|litros?|gramas?|quilos?|g|l|unidades?|un\.?)(?![\p{L}\d])/giu);
    return matches ? matches.map(value => value.trim()).join(' · ') : '';
  }

  function productUnit(name) {
    return /(?:\/\s*kg\b|\bpor\s+(?:kg|quilo)\b|(?:^|\s)kg\s*$)/i.test(name) && !/\d\s*kg\s*$/i.test(name) ? 'kg' : 'un.';
  }

  function parse(text, options) {
    const rows = [], errors = [], warnings = [];
    const requestedMax = options && Number(options.maxItems);
    const max = Number.isInteger(requestedMax) && requestedMax > 0 ? Math.min(60, requestedMax) : 60;
    let header = null, dataCount = 0, overflowReported = false;
    for (const record of recordsFrom(text)) {
      if (!record.text.trim()) continue;
      try {
        if (record.unclosed) throw new Error('Faltou fechar uma aspa nesta linha.');
        const result = columns(record.text);
        let values = result.values;
        const foundHeader = headerFor(values);
        if (foundHeader) { header = {...foundHeader, delimiter: result.delimiter}; continue; }
        dataCount++;
        if (dataCount > max) {
          if (!overflowReported) errors.push({line: record.line, message: 'O encarte aceita no máximo ' + max + ' produtos. Divida a lista antes de importar.'});
          overflowReported = true;
          continue;
        }
        // Decimal commas without CSV quotes are accepted only when their two
        // numeric fields have an unambiguous name/price/(club) position.
        if (result.delimiter === ',' && values.length >= 3 && values.length <= 4 && (!header || (header.name === 0 && header.price === 1 && (header.club === 2 || header.club === -1)))) {
          if (/^(?:R\$\s*)?\d+$/.test(values[1]) && /^\d{2}$/.test(values[2])) {
            values = [values[0], values[1] + ',' + values[2], ...values.slice(3)];
          }
        }
        const activeHeader = header && header.delimiter === result.delimiter ? header : null;
        const count = activeHeader ? activeHeader.length : 3;
        if (values.length < 2) throw new Error('Informe nome e preço separados por ponto e vírgula, tabulação ou travessão. Ex.: Arroz 5 kg; 18,95; sim.');
        if (values.length > count) throw new Error('Há colunas a mais. Use nome; preço; clube. Em CSV, coloque textos com vírgula entre aspas.');
        const name = clean(values[activeHeader ? activeHeader.name : 0]).replace(/\s+/g, ' ');
        const rawPrice = values[activeHeader ? activeHeader.price : 1];
        const rawClub = activeHeader ? (activeHeader.club >= 0 ? values[activeHeader.club] : '') : values[2];
        if (!name) throw new Error('O nome do produto está vazio.');
        if (name.length > 150) throw new Error('O nome do produto deve ter no máximo 150 caracteres.');
        const price = parsePrice(rawPrice);
        if (price === null) throw new Error('Preço inválido ou ausente. Informe um valor como 12,99; o peso do produto não é usado como preço.');
        const club = parseClub(rawClub);
        if (club === null) throw new Error('Clube inválido. Use sim/não, clube/normal, true/false ou 1/0.');
        rows.push({name, price, club, description: sizeDescription(name), unit: productUnit(name), line: record.line});
      } catch (error) {
        errors.push({line: record.line, message: error.message});
      }
    }
    if (!rows.length && !errors.length) errors.push({line: 1, message: 'Cole uma lista com pelo menos um produto e seu preço.'});
    return {rows, errors, warnings};
  }

  return {parse, parsePrice, parseClub};
});
