/**
 * @file stk-pkt-linq.js
 * @description Mecanismo Canônico de LINQ Fluente e Operações Funcionais (Zero-Knowledge, Zero-Dependency).
 * @author Principal Computer & Software Engineer (L6) | Systekna
 * @version 1.0.0
 * @license Proprietary - Systekna Global Ecosystem
 */

/**
 * Comparador padrão para ordenação determinística
 */
const _defaultComparer = (a, b) => {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'string' && typeof b === 'string') {
    return a.localeCompare(b);
  }
  return a < b ? -1 : 1;
};

/**
 * Sentinela privada para identificar ausência sem conflito com valores falsy ou null/undefined
 */
const _NOT_FOUND = Symbol('NOT_FOUND');

/**
 * Classe Enumerable que provê API fluente LINQ nativa
 * @template T
 */
export class Enumerable {
  /**
   * @param {Iterable<T>|Array<T>} source
   */
  constructor(source) {
    if (source == null) {
      this._source = [];
    } else if (Array.isArray(source)) {
      this._source = source;
    } else if (typeof source[Symbol.iterator] === 'function') {
      this._source = Array.from(source);
    } else {
      this._source = [source];
    }
  }

  /**
   * Factory principal: Cria uma instância Enumerable a partir de qualquer iterável
   * @template T
   * @param {Iterable<T>|Array<T>|Enumerable<T>} source
   * @returns {Enumerable<T>}
   */
  static from(source) {
    if (source instanceof Enumerable) return source;
    return new Enumerable(source);
  }

  /**
   * Gera uma sequência de números inteiros
   * @param {number} start
   * @param {number} count
   * @returns {Enumerable<number>}
   */
  static range(start, count) {
    if (count < 0) throw new RangeError('count deve ser não-negativo');
    const result = new Array(count);
    for (let i = 0; i < count; i++) {
      result[i] = start + i;
    }
    return new Enumerable(result);
  }

  /**
   * Gera uma sequência contendo um elemento repetido
   * @template T
   * @param {T} element
   * @param {number} count
   * @returns {Enumerable<T>}
   */
  static repeat(element, count) {
    if (count < 0) throw new RangeError('count deve ser não-negativo');
    const result = new Array(count);
    for (let i = 0; i < count; i++) {
      result[i] = element;
    }
    return new Enumerable(result);
  }

  /**
   * Retorna uma sequência vazia
   * @returns {Enumerable<any>}
   */
  static empty() {
    return new Enumerable([]);
  }

  /**
   * Filtra elementos baseado em um predicado
   * @param {(item: T, index: number) => boolean} predicate
   * @returns {Enumerable<T>}
   */
  where(predicate) {
    if (typeof predicate !== 'function') throw new TypeError('predicate deve ser uma função');
    const filtered = [];
    const len = this._source.length;
    for (let i = 0; i < len; i++) {
      const item = this._source[i];
      if (predicate(item, i)) {
        filtered.push(item);
      }
    }
    return new Enumerable(filtered);
  }

  /**
   * Projeta cada elemento em uma nova forma
   * @template R
   * @param {(item: T, index: number) => R} selector
   * @returns {Enumerable<R>}
   */
  select(selector) {
    if (typeof selector !== 'function') throw new TypeError('selector deve ser uma função');
    const len = this._source.length;
    const mapped = new Array(len);
    for (let i = 0; i < len; i++) {
      mapped[i] = selector(this._source[i], i);
    }
    return new Enumerable(mapped);
  }

  /**
   * Projeta e nivela coleções secundárias (flatMap)
   * @template R
   * @param {(item: T, index: number) => Iterable<R>} collectionSelector
   * @param {(item: T, subItem: R) => any} [resultSelector]
   * @returns {Enumerable<any>}
   */
  selectMany(collectionSelector, resultSelector) {
    if (typeof collectionSelector !== 'function') throw new TypeError('collectionSelector deve ser uma função');
    const result = [];
    const len = this._source.length;
    for (let i = 0; i < len; i++) {
      const item = this._source[i];
      const subCollection = collectionSelector(item, i);
      if (subCollection != null) {
        for (const subItem of subCollection) {
          result.push(resultSelector ? resultSelector(item, subItem) : subItem);
        }
      }
    }
    return new Enumerable(result);
  }

  /**
   * Filtra os elementos por tipo primitivo ou classe
   * @param {string|Function} type
   * @returns {Enumerable<any>}
   */
  ofType(type) {
    if (typeof type === 'string') {
      return this.where(x => typeof x === type);
    }
    if (typeof type === 'function') {
      return this.where(x => x instanceof type);
    }
    return new Enumerable([]);
  }

  /**
   * Retorna o primeiro elemento que satisfaz a condição ou dispara exceção
   * @param {(item: T) => boolean} [predicate]
   * @returns {T}
   */
  first(predicate) {
    const item = this.firstOrDefault(predicate, _NOT_FOUND);
    if (item === _NOT_FOUND) {
      throw new Error('A sequência não contém elemento correspondente.');
    }
    return item;
  }

  /**
   * Retorna o primeiro elemento ou um valor padrão caso não encontre
   * @template D
   * @param {(item: T) => boolean} [predicate]
   * @param {D} [defaultValue=null]
   * @returns {T|D}
   */
  firstOrDefault(predicate, defaultValue = null) {
    const fallback = arguments.length > 1 ? defaultValue : null;
    if (!predicate) {
      return this._source.length > 0 ? this._source[0] : fallback;
    }
    const len = this._source.length;
    for (let i = 0; i < len; i++) {
      const item = this._source[i];
      if (predicate(item, i)) return item;
    }
    return fallback;
  }

  /**
   * Retorna o último elemento que satisfaz a condição ou dispara exceção
   * @param {(item: T) => boolean} [predicate]
   * @returns {T}
   */
  last(predicate) {
    const item = this.lastOrDefault(predicate, _NOT_FOUND);
    if (item === _NOT_FOUND) {
      throw new Error('A sequência não contém elemento correspondente.');
    }
    return item;
  }

  /**
   * Retorna o último elemento ou um valor padrão
   * @template D
   * @param {(item: T) => boolean} [predicate]
   * @param {D} [defaultValue=null]
   * @returns {T|D}
   */
  lastOrDefault(predicate, defaultValue = null) {
    const fallback = arguments.length > 1 ? defaultValue : null;
    const len = this._source.length;
    if (!predicate) {
      return len > 0 ? this._source[len - 1] : fallback;
    }
    for (let i = len - 1; i >= 0; i--) {
      const item = this._source[i];
      if (predicate(item, i)) return item;
    }
    return fallback;
  }

  /**
   * Garante que haja exatamente um elemento na sequência
   * @param {(item: T) => boolean} [predicate]
   * @returns {T}
   */
  single(predicate) {
    const items = predicate ? this.where(predicate).toArray() : this._source;
    if (items.length === 0) throw new Error('A sequência está vazia.');
    if (items.length > 1) throw new Error('A sequência contém mais de um elemento.');
    return items[0];
  }

  /**
   * Retorna o único elemento ou padrão caso vazia; lança erro se houver mais de um
   * @template D
   * @param {(item: T) => boolean} [predicate]
   * @param {D} [defaultValue=null]
   * @returns {T|D}
   */
  singleOrDefault(predicate, defaultValue = null) {
    const items = predicate ? this.where(predicate).toArray() : this._source;
    if (items.length === 0) return defaultValue;
    if (items.length > 1) throw new Error('A sequência contém mais de um elemento.');
    return items[0];
  }

  /**
   * Retorna o elemento no índice especificado
   * @param {number} index
   * @returns {T}
   */
  elementAt(index) {
    const item = this.elementAtOrDefault(index, _NOT_FOUND);
    if (item === _NOT_FOUND) throw new RangeError(`Índice fora dos limites: ${index}`);
    return item;
  }

  /**
   * Retorna o elemento no índice especificado ou valor padrão
   * @template D
   * @param {number} index
   * @param {D} [defaultValue=null]
   * @returns {T|D}
   */
  elementAtOrDefault(index, defaultValue = null) {
    const fallback = arguments.length > 1 ? defaultValue : null;
    const actualIndex = index < 0 ? this._source.length + index : index;
    if (actualIndex >= 0 && actualIndex < this._source.length) {
      return this._source[actualIndex];
    }
    return fallback;
  }

  /**
   * Verifica se qualquer elemento satisfaz a condição (ou se há ao menos 1 item)
   * @param {(item: T) => boolean} [predicate]
   * @returns {boolean}
   */
  any(predicate) {
    if (!predicate) return this._source.length > 0;
    return this._source.some(predicate);
  }

  /**
   * Verifica se todos os elementos satisfazem a condição
   * @param {(item: T) => boolean} predicate
   * @returns {boolean}
   */
  all(predicate) {
    if (typeof predicate !== 'function') throw new TypeError('predicate deve ser uma função');
    return this._source.every(predicate);
  }

  /**
   * Verifica se a sequência contém determinado elemento
   * @param {T} value
   * @param {(a: T, b: T) => boolean} [comparer]
   * @returns {boolean}
   */
  contains(value, comparer) {
    if (!comparer) return this._source.includes(value);
    return this._source.some(item => comparer(item, value));
  }

  /**
   * Retorna a quantidade de elementos que satisfazem o predicado (ou o total)
   * @param {(item: T) => boolean} [predicate]
   * @returns {number}
   */
  count(predicate) {
    if (!predicate) return this._source.length;
    let c = 0;
    const len = this._source.length;
    for (let i = 0; i < len; i++) {
      if (predicate(this._source[i], i)) c++;
    }
    return c;
  }

  /**
   * Soma numérica simples
   * @param {(item: T) => number} [selector]
   * @returns {number}
   */
  sum(selector = x => x) {
    let total = 0;
    const len = this._source.length;
    for (let i = 0; i < len; i++) {
      const val = Number(selector(this._source[i]));
      if (!Number.isNaN(val)) total += val;
    }
    return total;
  }

  /**
   * Soma de precisão com BigInt (evita estouros e drift flutuante)
   * @param {(item: T) => bigint} selector
   * @returns {bigint}
   */
  sumBigInt(selector) {
    if (typeof selector !== 'function') throw new TypeError('selector deve ser uma função');
    let total = 0n;
    const len = this._source.length;
    for (let i = 0; i < len; i++) {
      const val = BigInt(selector(this._source[i]));
      total += val;
    }
    return total;
  }

  /**
   * Média aritmética
   * @param {(item: T) => number} [selector]
   * @returns {number}
   */
  average(selector = x => x) {
    if (this._source.length === 0) throw new Error('A sequência está vazia.');
    return this.sum(selector) / this._source.length;
  }

  /**
   * Valor mínimo
   * @param {(item: T) => any} [selector]
   * @returns {any}
   */
  min(selector = x => x) {
    if (this._source.length === 0) throw new Error('A sequência está vazia.');
    let minVal = selector(this._source[0]);
    for (let i = 1; i < this._source.length; i++) {
      const curr = selector(this._source[i]);
      if (curr < minVal) minVal = curr;
    }
    return minVal;
  }

  /**
   * Valor máximo
   * @param {(item: T) => any} [selector]
   * @returns {any}
   */
  max(selector = x => x) {
    if (this._source.length === 0) throw new Error('A sequência está vazia.');
    let maxVal = selector(this._source[0]);
    for (let i = 1; i < this._source.length; i++) {
      const curr = selector(this._source[i]);
      if (curr > maxVal) maxVal = curr;
    }
    return maxVal;
  }

  /**
   * Redução / Acumulação declarativa (Fold)
   * @template R
   * @param {R} seed
   * @param {(accumulator: R, current: T) => R} func
   * @returns {R}
   */
  aggregate(seed, func) {
    if (typeof func !== 'function') throw new TypeError('func deve ser uma função');
    return this._source.reduce(func, seed);
  }

  /**
   * Pula N elementos
   * @param {number} count
   * @returns {Enumerable<T>}
   */
  skip(count) {
    const start = Math.max(0, count);
    return new Enumerable(this._source.slice(start));
  }

  /**
   * Pula elementos enquanto o predicado for verdadeiro
   * @param {(item: T, index: number) => boolean} predicate
   * @returns {Enumerable<T>}
   */
  skipWhile(predicate) {
    let idx = 0;
    while (idx < this._source.length && predicate(this._source[idx], idx)) {
      idx++;
    }
    return new Enumerable(this._source.slice(idx));
  }

  /**
   * Seleciona os primeiros N elementos
   * @param {number} count
   * @returns {Enumerable<T>}
   */
  take(count) {
    const end = Math.max(0, count);
    return new Enumerable(this._source.slice(0, end));
  }

  /**
   * Seleciona elementos enquanto o predicado for verdadeiro
   * @param {(item: T, index: number) => boolean} predicate
   * @returns {Enumerable<T>}
   */
  takeWhile(predicate) {
    const result = [];
    for (let i = 0; i < this._source.length; i++) {
      const item = this._source[i];
      if (!predicate(item, i)) break;
      result.push(item);
    }
    return new Enumerable(result);
  }

  /**
   * Divide a sequência em blocos de tamanho especificado
   * @param {number} size
   * @returns {Enumerable<Array<T>>}
   */
  chunk(size) {
    if (size <= 0) throw new RangeError('size deve ser maior que 0');
    const chunks = [];
    for (let i = 0; i < this._source.length; i += size) {
      chunks.push(this._source.slice(i, i + size));
    }
    return new Enumerable(chunks);
  }

  /**
   * Remove duplicatas da sequência
   * @param {(item: T) => any} [keySelector]
   * @returns {Enumerable<T>}
   */
  distinct(keySelector) {
    if (!keySelector) {
      return new Enumerable([...new Set(this._source)]);
    }
    const seen = new Set();
    const result = [];
    const len = this._source.length;
    for (let i = 0; i < len; i++) {
      const item = this._source[i];
      const key = keySelector(item);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(item);
      }
    }
    return new Enumerable(result);
  }

  /**
   * Ordenação ascendente imutável
   * @param {(item: T) => any} [keySelector=x => x]
   * @param {(a: any, b: any) => number} [comparer]
   * @returns {OrderedEnumerable<T>}
   */
  orderBy(keySelector = x => x, comparer = _defaultComparer) {
    return new OrderedEnumerable(this._source, [{ keySelector, comparer, descending: false }]);
  }

  /**
   * Ordenação descendente imutável
   * @param {(item: T) => any} [keySelector=x => x]
   * @param {(a: any, b: any) => number} [comparer]
   * @returns {OrderedEnumerable<T>}
   */
  orderByDescending(keySelector = x => x, comparer = _defaultComparer) {
    return new OrderedEnumerable(this._source, [{ keySelector, comparer, descending: true }]);
  }

  /**
   * Agrupa elementos por chave
   * @template K, R
   * @param {(item: T) => K} keySelector
   * @param {(item: T) => any} [elementSelector]
   * @param {(key: K, group: Enumerable<any>) => R} [resultSelector]
   * @returns {Enumerable<any>}
   */
  groupBy(keySelector, elementSelector = x => x, resultSelector) {
    if (typeof keySelector !== 'function') throw new TypeError('keySelector deve ser uma função');
    const groups = new Map();
    const len = this._source.length;

    for (let i = 0; i < len; i++) {
      const item = this._source[i];
      const key = keySelector(item);
      let list = groups.get(key);
      if (!list) {
        list = [];
        groups.set(key, list);
      }
      list.push(elementSelector(item));
    }

    const results = [];
    for (const [key, elements] of groups.entries()) {
      const groupEnumerable = new Enumerable(elements);
      if (resultSelector) {
        results.push(resultSelector(key, groupEnumerable));
      } else {
        results.push({
          key,
          elements: groupEnumerable,
          count: elements.length,
          toArray: () => elements
        });
      }
    }

    return new Enumerable(results);
  }

  /**
   * Concatena duas sequências
   * @param {Iterable<T>} second
   * @returns {Enumerable<T>}
   */
  concat(second) {
    const other = Array.from(second || []);
    return new Enumerable(this._source.concat(other));
  }

  /**
   * União de duas sequências sem duplicações
   * @param {Iterable<T>} second
   * @param {(item: T) => any} [keySelector]
   * @returns {Enumerable<T>}
   */
  union(second, keySelector) {
    return this.concat(second).distinct(keySelector);
  }

  /**
   * Interseção de duas sequências
   * @param {Iterable<T>} second
   * @param {(item: T) => any} [keySelector]
   * @returns {Enumerable<T>}
   */
  intersect(second, keySelector) {
    const secondArr = Array.from(second || []);
    const secondKeys = new Set(keySelector ? secondArr.map(keySelector) : secondArr);
    return this.where(item => {
      const key = keySelector ? keySelector(item) : item;
      return secondKeys.has(key);
    }).distinct(keySelector);
  }

  /**
   * Diferença entre duas sequências (Itens em A mas não em B)
   * @param {Iterable<T>} second
   * @param {(item: T) => any} [keySelector]
   * @returns {Enumerable<T>}
   */
  except(second, keySelector) {
    const secondArr = Array.from(second || []);
    const secondKeys = new Set(keySelector ? secondArr.map(keySelector) : secondArr);
    return this.where(item => {
      const key = keySelector ? keySelector(item) : item;
      return !secondKeys.has(key);
    }).distinct(keySelector);
  }

  /**
   * Combina duas sequências elemento a elemento
   * @template T2, R
   * @param {Iterable<T2>} second
   * @param {(first: T, second: T2) => R} resultSelector
   * @returns {Enumerable<R>}
   */
  zip(second, resultSelector) {
    const secondArr = Array.from(second || []);
    const minLen = Math.min(this._source.length, secondArr.length);
    const result = new Array(minLen);
    for (let i = 0; i < minLen; i++) {
      result[i] = resultSelector(this._source[i], secondArr[i]);
    }
    return new Enumerable(result);
  }

  /**
   * Executa uma ação com efeito colateral para cada item
   * @param {(item: T, index: number) => void} action
   * @returns {this}
   */
  forEach(action) {
    if (typeof action !== 'function') throw new TypeError('action deve ser uma função');
    const len = this._source.length;
    for (let i = 0; i < len; i++) {
      action(this._source[i], i);
    }
    return this;
  }

  /**
   * Converte para Array nativo
   * @returns {Array<T>}
   */
  toArray() {
    return this._source.slice();
  }

  /**
   * Sinônimo de toArray()
   * @returns {Array<T>}
   */
  toList() {
    return this.toArray();
  }

  /**
   * Converte para Set nativo
   * @returns {Set<T>}
   */
  toSet() {
    return new Set(this._source);
  }

  /**
   * Converte para Map nativo
   * @template K, V
   * @param {(item: T) => K} keySelector
   * @param {(item: T) => V} [elementSelector=x => x]
   * @returns {Map<K, V>}
   */
  toMap(keySelector, elementSelector = x => x) {
    if (typeof keySelector !== 'function') throw new TypeError('keySelector deve ser uma função');
    const map = new Map();
    const len = this._source.length;
    for (let i = 0; i < len; i++) {
      const item = this._source[i];
      map.set(keySelector(item), elementSelector(item));
    }
    return map;
  }

  /**
   * Converte para Dictionary (Objeto plano)
   * @template V
   * @param {(item: T) => string|number} keySelector
   * @param {(item: T) => V} [elementSelector=x => x]
   * @returns {Record<string, V>}
   */
  toDictionary(keySelector, elementSelector = x => x) {
    if (typeof keySelector !== 'function') throw new TypeError('keySelector deve ser uma função');
    const dict = Object.create(null);
    const len = this._source.length;
    for (let i = 0; i < len; i++) {
      const item = this._source[i];
      dict[keySelector(item)] = elementSelector(item);
    }
    return dict;
  }

  /**
   * Permite iteração via for...of e spread [...enumerable]
   */
  [Symbol.iterator]() {
    return this._source[Symbol.iterator]();
  }
}

/**
 * Classe especializada para ordenação multinível (ThenBy / ThenByDescending)
 * @template T
 * @extends Enumerable<T>
 */
export class OrderedEnumerable extends Enumerable {
  /**
   * @param {Array<T>} source
   * @param {Array<{keySelector: Function, comparer: Function, descending: boolean}>} criteria
   */
  constructor(source, criteria) {
    super([]);
    this._rawSource = source;
    this._criteria = criteria;
    this._source = this._sort();
  }

  thenBy(keySelector = x => x, comparer = _defaultComparer) {
    return new OrderedEnumerable(this._rawSource, [
      ...this._criteria,
      { keySelector, comparer, descending: false }
    ]);
  }

  thenByDescending(keySelector = x => x, comparer = _defaultComparer) {
    return new OrderedEnumerable(this._rawSource, [
      ...this._criteria,
      { keySelector, comparer, descending: true }
    ]);
  }

  _sort() {
    const copy = this._rawSource.slice();
    copy.sort((a, b) => {
      for (let i = 0; i < this._criteria.length; i++) {
        const { keySelector, comparer, descending } = this._criteria[i];
        const ka = keySelector(a);
        const kb = keySelector(b);
        const res = comparer(ka, kb);
        if (res !== 0) {
          return descending ? -res : res;
        }
      }
      return 0;
    });
    return copy;
  }
}

/**
 * Helper funcional direto
 * @template T
 * @param {Iterable<T>} source
 * @returns {Enumerable<T>}
 */
export function from(source) {
  return Enumerable.from(source);
}

export const asEnumerable = from;
export const $linq = from;

// Aliases na classe para compatibilidade com default import
Enumerable.Enumerable = Enumerable;
Enumerable.OrderedEnumerable = OrderedEnumerable;
Enumerable.asEnumerable = from;
Enumerable.$linq = from;

// Anexação defensiva em ambiente global (Browser / Window / Worker)
if (typeof globalThis !== 'undefined') {
  globalThis.Enumerable = Enumerable;
  globalThis.$linq = from;
  globalThis.asEnumerable = from;
  globalThis.from = from;
}

export default Enumerable;
