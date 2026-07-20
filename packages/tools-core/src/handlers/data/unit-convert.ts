/**
 * WARP-1424 — `unit_convert` LLM tool.
 *
 * Misc dev-utility: converts a value between units of length, mass,
 * temperature, volume (US), area, speed, or data size. Tier-1 read;
 * pure computation, no I/O.
 *
 * Linear categories convert via a per-unit factor to a category base
 * unit (m, kg, l, m2, m/s, byte). Temperature is the one AFFINE
 * category — °C/°F/K are related by offset as well as scale, so those
 * units carry explicit toBase/fromBase transforms through Kelvin
 * instead of a factor. Data sizes distinguish decimal kB/MB/GB/TB
 * (powers of 1000) from binary KiB/MiB/GiB/TiB (powers of 1024). Unit
 * matching is case-insensitive and tolerant of plurals/long names via
 * an alias table ("meters", "pounds", "fluid_ounces", ...).
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

type Category =
  | "length"
  | "mass"
  | "temperature"
  | "volume"
  | "area"
  | "speed"
  | "data";

interface UnitDef {
  category: Category;
  toBase: (v: number) => number;
  fromBase: (v: number) => number;
}

/** Linear unit: `factor` × unit = base unit. */
function linear(category: Category, factor: number): UnitDef {
  return {
    category,
    toBase: (v) => v * factor,
    fromBase: (v) => v / factor,
  };
}

/** Canonical unit id → definition. Base units: m, kg, K, l, m2, m/s, byte. */
const UNITS: Record<string, UnitDef> = {
  // length (base m)
  mm: linear("length", 0.001),
  cm: linear("length", 0.01),
  m: linear("length", 1),
  km: linear("length", 1000),
  in: linear("length", 0.0254),
  ft: linear("length", 0.3048),
  yd: linear("length", 0.9144),
  mi: linear("length", 1609.344),
  // mass (base kg)
  mg: linear("mass", 1e-6),
  g: linear("mass", 0.001),
  kg: linear("mass", 1),
  t: linear("mass", 1000),
  oz: linear("mass", 0.028349523125),
  lb: linear("mass", 0.45359237),
  st: linear("mass", 6.35029318),
  // temperature — affine, converted through Kelvin as the base
  c: {
    category: "temperature",
    toBase: (v) => v + 273.15,
    fromBase: (v) => v - 273.15,
  },
  f: {
    category: "temperature",
    toBase: (v) => ((v - 32) * 5) / 9 + 273.15,
    fromBase: (v) => ((v - 273.15) * 9) / 5 + 32,
  },
  k: {
    category: "temperature",
    toBase: (v) => v,
    fromBase: (v) => v,
  },
  // volume, US (base l)
  ml: linear("volume", 0.001),
  l: linear("volume", 1),
  m3: linear("volume", 1000),
  tsp: linear("volume", 0.00492892159375),
  tbsp: linear("volume", 0.01478676478125),
  fl_oz: linear("volume", 0.0295735295625),
  cup: linear("volume", 0.2365882365),
  pt: linear("volume", 0.473176473),
  qt: linear("volume", 0.946352946),
  gal: linear("volume", 3.785411784),
  // area (base m2)
  m2: linear("area", 1),
  km2: linear("area", 1e6),
  ft2: linear("area", 0.09290304),
  acre: linear("area", 4046.8564224),
  ha: linear("area", 10000),
  // speed (base m/s)
  mps: linear("speed", 1),
  kmh: linear("speed", 1000 / 3600),
  mph: linear("speed", 0.44704),
  knot: linear("speed", 1852 / 3600),
  // data (base byte) — decimal ×1000ⁿ vs binary ×1024ⁿ
  b: linear("data", 1),
  kb: linear("data", 1e3),
  mb: linear("data", 1e6),
  gb: linear("data", 1e9),
  tb: linear("data", 1e12),
  kib: linear("data", 1024),
  mib: linear("data", 1024 ** 2),
  gib: linear("data", 1024 ** 3),
  tib: linear("data", 1024 ** 4),
};

/** Alias (lowercase) → canonical unit id. Canonical ids resolve to themselves. */
const ALIASES: Record<string, string> = {
  // length
  millimeter: "mm", millimeters: "mm", millimetre: "mm", millimetres: "mm",
  centimeter: "cm", centimeters: "cm", centimetre: "cm", centimetres: "cm",
  meter: "m", meters: "m", metre: "m", metres: "m",
  kilometer: "km", kilometers: "km", kilometre: "km", kilometres: "km",
  inch: "in", inches: "in",
  foot: "ft", feet: "ft",
  yard: "yd", yards: "yd",
  mile: "mi", miles: "mi",
  // mass
  milligram: "mg", milligrams: "mg",
  gram: "g", grams: "g",
  kilogram: "kg", kilograms: "kg",
  ton: "t", tonne: "t", tonnes: "t",
  ounce: "oz", ounces: "oz",
  pound: "lb", pounds: "lb", lbs: "lb",
  stone: "st", stones: "st",
  // temperature
  celsius: "c", centigrade: "c", "°c": "c",
  fahrenheit: "f", "°f": "f",
  kelvin: "k",
  // volume
  milliliter: "ml", milliliters: "ml", millilitre: "ml", millilitres: "ml",
  liter: "l", liters: "l", litre: "l", litres: "l",
  cubic_meter: "m3", cubic_meters: "m3",
  teaspoon: "tsp", teaspoons: "tsp",
  tablespoon: "tbsp", tablespoons: "tbsp",
  fluid_ounce: "fl_oz", fluid_ounces: "fl_oz", floz: "fl_oz",
  cups: "cup",
  pint: "pt", pints: "pt",
  quart: "qt", quarts: "qt",
  gallon: "gal", gallons: "gal",
  // area
  sqm: "m2", square_meter: "m2", square_meters: "m2",
  sqkm: "km2", square_kilometer: "km2", square_kilometers: "km2",
  sqft: "ft2", square_feet: "ft2", square_foot: "ft2",
  acres: "acre",
  hectare: "ha", hectares: "ha",
  // speed
  "m/s": "mps",
  "km/h": "kmh", kph: "kmh",
  "mi/h": "mph",
  knots: "knot", kn: "knot",
  // data
  byte: "b", bytes: "b",
  kilobyte: "kb", kilobytes: "kb",
  megabyte: "mb", megabytes: "mb",
  gigabyte: "gb", gigabytes: "gb",
  terabyte: "tb", terabytes: "tb",
  kibibyte: "kib", kibibytes: "kib",
  mebibyte: "mib", mebibytes: "mib",
  gibibyte: "gib", gibibytes: "gib",
  tebibyte: "tib", tebibytes: "tib",
};

const CATEGORIES: readonly Category[] = [
  "length",
  "mass",
  "temperature",
  "volume",
  "area",
  "speed",
  "data",
];

/** Resolve a raw unit string (any case, alias or canonical) to its canonical id. */
function resolveUnit(raw: string): string | undefined {
  const key = raw.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(UNITS, key)) return key;
  if (Object.prototype.hasOwnProperty.call(ALIASES, key)) return ALIASES[key];
  return undefined;
}

function unitsOfCategory(category: Category): string[] {
  return Object.keys(UNITS).filter((id) => UNITS[id].category === category);
}

const inputSchema = {
  type: "object",
  properties: {
    value: {
      type: "number",
      description: "The numeric value to convert (must be finite).",
    },
    from: {
      type: "string",
      description:
        "The source unit, e.g. 'km', 'meters', 'lb', 'celsius', 'gal', 'ha', 'kmh', 'GiB'. Case-insensitive; plurals and long names are accepted.",
    },
    to: {
      type: "string",
      description:
        "The target unit, in the same category as `from`. Same naming tolerance as `from`.",
    },
  },
  required: ["value", "from", "to"],
  additionalProperties: false,
} as const;

async function handler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const value = args.value;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "INVALID_VALUE",
        message: "value must be a finite number",
      },
    };
  }

  const rawFrom = typeof args.from === "string" ? args.from : "";
  const rawTo = typeof args.to === "string" ? args.to : "";
  const from = rawFrom ? resolveUnit(rawFrom) : undefined;
  const to = rawTo ? resolveUnit(rawTo) : undefined;
  if (from === undefined || to === undefined) {
    const offending = from === undefined ? rawFrom || "(missing)" : rawTo || "(missing)";
    return {
      ok: false,
      status: "error",
      error: {
        code: "UNKNOWN_UNIT",
        message: `unknown unit '${offending}'; known categories: ${CATEGORIES.join(", ")}`,
      },
    };
  }

  const fromDef = UNITS[from];
  const toDef = UNITS[to];
  if (fromDef.category !== toDef.category) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "CATEGORY_MISMATCH",
        message:
          `cannot convert '${from}' (${fromDef.category}) to '${to}' (${toDef.category}); ` +
          `valid ${fromDef.category} units: ${unitsOfCategory(fromDef.category).join(", ")}`,
      },
    };
  }

  const result = toDef.fromBase(fromDef.toBase(value));

  return {
    ok: true,
    data: {
      type: "unit_convert",
      value,
      from,
      to,
      result,
      category: fromDef.category,
    },
  };
}

const tool: Tool = {
  name: "unit_convert",
  description:
    "Convert a value between units of length, mass, temperature, volume (US), area, speed, or data size. Pass `value` plus `from` and `to` units of the same category (e.g. km→mi, kg→lb, celsius→fahrenheit, l→gal, ha→acre, kmh→mph, GB→GiB). Data units distinguish decimal kB/MB/GB/TB (powers of 1000) from binary KiB/MiB/GiB/TiB (powers of 1024). Unit names are case-insensitive and accept common aliases (plurals and long names like 'meters', 'pounds', 'fluid_ounces'). Tier-1 read; pure computation.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
