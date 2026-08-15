import { ValidationError } from "./errs/index.js";

export interface JsonInputLimits {
  maxBytes: number;
  maxDepth: number;
  maxProperties: number;
  maxArrayItems: number;
  maxIssues: number;
}

/** A strict, bounded JSON parser. It rejects duplicate and prototype-polluting object keys. */
export function parseStrictJson(text: string, limits: JsonInputLimits): unknown {
  return new StrictJsonParser(text, limits).parse();
}

class StrictJsonParser {
  #index = 0;
  #nodes = 0;
  #properties = 0;
  #arrayItems = 0;
  readonly #text: string;
  readonly #limits: JsonInputLimits;

  constructor(text: string, limits: JsonInputLimits) {
    this.#text = text;
    this.#limits = limits;
  }

  parse(): unknown {
    this.#space();
    if (this.#index === this.#text.length) this.#fail("Input is empty");
    const value = this.#value(0);
    this.#space();
    if (this.#index !== this.#text.length) this.#fail("Unexpected token after JSON value");
    return value;
  }

  #value(depth: number): unknown {
    if (depth > this.#limits.maxDepth)
      this.#limit(`JSON exceeds max depth ${this.#limits.maxDepth}`);
    this.#nodes++;
    if (this.#nodes > this.#limits.maxProperties + this.#limits.maxArrayItems + 1) {
      this.#limit("JSON structure is too complex");
    }
    this.#space();
    const token = this.#text[this.#index];
    if (token === "{") return this.#object(depth + 1);
    if (token === "[") return this.#array(depth + 1);
    if (token === '"') return this.#string();
    if (token === "t" && this.#literal("true")) return true;
    if (token === "f" && this.#literal("false")) return false;
    if (token === "n" && this.#literal("null")) return null;
    if (token === "-" || (token !== undefined && token >= "0" && token <= "9")) {
      return this.#number();
    }
    this.#fail("Invalid JSON value");
  }

  #object(depth: number): Record<string, unknown> {
    this.#index++;
    const result: Record<string, unknown> = Object.create(null);
    const keys = new Set<string>();
    this.#space();
    if (this.#take("}")) return result;
    while (true) {
      this.#space();
      if (this.#text[this.#index] !== '"') this.#fail("Object key must be a string");
      const key = this.#string();
      if (keys.has(key)) this.#fail(`Duplicate object key at ${this.#location()}`);
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        this.#fail("Unsafe object key is not allowed");
      }
      keys.add(key);
      this.#properties++;
      if (this.#properties > this.#limits.maxProperties) {
        this.#limit(`JSON exceeds max properties ${this.#limits.maxProperties}`);
      }
      this.#space();
      if (!this.#take(":")) this.#fail("Expected ':' after object key");
      result[key] = this.#value(depth);
      this.#space();
      if (this.#take("}")) return result;
      if (!this.#take(",")) this.#fail("Expected ',' or '}' in object");
    }
  }

  #array(depth: number): unknown[] {
    this.#index++;
    const result: unknown[] = [];
    this.#space();
    if (this.#take("]")) return result;
    while (true) {
      this.#arrayItems++;
      if (this.#arrayItems > this.#limits.maxArrayItems) {
        this.#limit(`JSON exceeds max array items ${this.#limits.maxArrayItems}`);
      }
      result.push(this.#value(depth));
      this.#space();
      if (this.#take("]")) return result;
      if (!this.#take(",")) this.#fail("Expected ',' or ']' in array");
    }
  }

  #string(): string {
    const start = this.#index++;
    while (this.#index < this.#text.length) {
      const code = this.#text.charCodeAt(this.#index++);
      if (code === 0x22) {
        try {
          return JSON.parse(this.#text.slice(start, this.#index)) as string;
        } catch {
          this.#fail("Invalid JSON string escape");
        }
      }
      if (code < 0x20) this.#fail("Unescaped control character in JSON string");
      if (code === 0x5c) {
        const escaped = this.#text.charCodeAt(this.#index++);
        if (escaped === 0x75) {
          const hex = this.#text.slice(this.#index, this.#index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.#fail("Invalid unicode escape");
          this.#index += 4;
        } else if (![0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74].includes(escaped)) {
          this.#fail("Invalid JSON string escape");
        }
      }
    }
    this.#fail("Unterminated JSON string");
  }

  #number(): number {
    const rest = this.#text.slice(this.#index);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (!match) this.#fail("Invalid JSON number");
    this.#index += match![0].length;
    const number = Number(match![0]);
    if (!Number.isFinite(number)) this.#limit("JSON number is outside the finite range");
    if (!match![0].includes(".") && !/[eE]/.test(match![0]) && !Number.isSafeInteger(number)) {
      this.#limit("JSON integer exceeds JavaScript safe integer range; encode it as a string");
    }
    return number;
  }

  #literal(value: string): boolean {
    if (!this.#text.startsWith(value, this.#index)) return false;
    this.#index += value.length;
    return true;
  }

  #space(): void {
    while (true) {
      const code = this.#text.charCodeAt(this.#index);
      if (code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x20) return;
      this.#index++;
    }
  }

  #take(value: string): boolean {
    if (this.#text[this.#index] !== value) return false;
    this.#index++;
    return true;
  }

  #location(): string {
    return `byte ${Buffer.byteLength(this.#text.slice(0, this.#index), "utf8")}`;
  }

  #fail(message: string): never {
    throw new ValidationError({
      subtype: "invalid_argument",
      param: "input",
      message: `${message} (${this.#location()})`,
      hint: "Provide strict JSON without comments, trailing commas, duplicate keys, or unsafe keys.",
    });
  }

  #limit(message: string): never {
    throw new ValidationError({ subtype: "out_of_range", param: "input", message });
  }
}
