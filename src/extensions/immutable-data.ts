export class UnsupportedImmutableValueError extends TypeError {
  public constructor(path: string, value: object) {
    const name =
      typeof value === 'function'
        ? 'function'
        : Array.isArray(value)
          ? 'Array'
          : 'object'
    super(`Immutable data at "${path}" cannot contain ${name}.`)
    this.name = 'UnsupportedImmutableValueError'
  }
}

export function freezeImmutableData<Value>(value: Value): Value {
  visit(value, '$', new WeakSet<object>())
  return value
}

function visit(value: unknown, path: string, seen: WeakSet<object>): void {
  if (typeof value === 'function') {
    throw new UnsupportedImmutableValueError(path, value)
  }
  if (value === null || typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)

  if (Array.isArray(value)) {
    if (Reflect.getPrototypeOf(value) !== Array.prototype) {
      throw new UnsupportedImmutableValueError(path, value)
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    for (const key of Reflect.ownKeys(descriptors)) {
      if (key === 'length') continue
      if (typeof key === 'symbol' || !isArrayIndex(key)) {
        throw new UnsupportedImmutableValueError(path, value)
      }
      const descriptor = descriptors[key]!
      if ('get' in descriptor || 'set' in descriptor) {
        throw new UnsupportedImmutableValueError(`${path}[${key}]`, value)
      }
      visit(descriptor.value, `${path}[${key}]`, seen)
    }
    Object.freeze(value)
    return
  }

  const prototype = Reflect.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new UnsupportedImmutableValueError(path, value)
  }

  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === 'symbol') {
      throw new UnsupportedImmutableValueError(path, value)
    }
    const descriptor = descriptors[key]!
    if ('get' in descriptor || 'set' in descriptor) {
      throw new UnsupportedImmutableValueError(`${path}.${key}`, value)
    }
    visit(descriptor.value, `${path}.${key}`, seen)
  }
  Object.freeze(value)
}

function isArrayIndex(key: string): boolean {
  const index = Number(key)
  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < 4_294_967_295 &&
    String(index) === key
  )
}

export class ReadonlyMapView<Key, Value> implements ReadonlyMap<Key, Value> {
  readonly #map: Map<Key, Value>

  public constructor(entries: Iterable<readonly [Key, Value]>) {
    this.#map = new Map(entries)
    Object.freeze(this)
  }

  public get size(): number {
    return this.#map.size
  }

  public get(key: Key): Value | undefined {
    return this.#map.get(key)
  }

  public has(key: Key): boolean {
    return this.#map.has(key)
  }

  public entries(): MapIterator<[Key, Value]> {
    return this.#map.entries()
  }

  public keys(): MapIterator<Key> {
    return this.#map.keys()
  }

  public values(): MapIterator<Value> {
    return this.#map.values()
  }

  public forEach(
    callbackfn: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void,
    thisArg?: unknown
  ): void {
    for (const [key, value] of this.#map) {
      callbackfn.call(thisArg, value, key, this)
    }
  }

  public [Symbol.iterator](): MapIterator<[Key, Value]> {
    return this.#map[Symbol.iterator]()
  }

  public get [Symbol.toStringTag](): string {
    return 'ReadonlyMap'
  }
}
