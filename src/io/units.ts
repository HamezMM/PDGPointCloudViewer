export type Unit = 'm' | 'mm' | 'cm' | 'ft' | 'in';

export const UNIT_TO_METRES: Record<Unit, number> = {
  m: 1,
  cm: 0.01,
  mm: 0.001,
  ft: 0.3048,
  in: 0.0254,
};

export const UNIT_LABELS: Record<Unit, string> = {
  m: 'metres',
  cm: 'centimetres',
  mm: 'millimetres',
  ft: 'feet',
  in: 'inches',
};

export type DisplayUnit = Unit | 'ft-in';

/** Format a length given in metres in the requested display unit. */
export function formatLength(metres: number, unit: DisplayUnit): string {
  if (unit === 'ft-in') {
    const totalIn = metres / 0.0254;
    const sign = totalIn < 0 ? '-' : '';
    const abs = Math.abs(totalIn);
    let ft = Math.floor(abs / 12);
    let inch = abs - ft * 12;
    // round to 1/16"
    inch = Math.round(inch * 16) / 16;
    if (inch >= 12) { ft += 1; inch -= 12; }
    const inchText = inch % 1 === 0 ? inch.toFixed(0) : inch.toFixed(4).replace(/0+$/, '');
    return `${sign}${ft}' ${inchText}"`;
  }
  const v = metres / UNIT_TO_METRES[unit];
  const decimals = unit === 'mm' ? 1 : unit === 'cm' ? 2 : unit === 'in' ? 3 : 4;
  return `${v.toFixed(decimals)} ${unit}`;
}
