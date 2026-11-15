// Filter and sort helpers shared by the Hints and History tables.

export type ClassFilter = 'any' | 'progression' | 'useful' | 'trap' | 'filler';
export type SortDir = 'asc' | 'desc';

/** Does an item with these classification flags pass the "Item type" filter? */
export function matchesClass(flags: number, filter: ClassFilter): boolean {
  switch (filter) {
    case 'progression':
      return (flags & 0b001) !== 0;
    case 'useful':
      return (flags & 0b010) !== 0;
    case 'trap':
      return (flags & 0b100) !== 0;
    case 'filler':
      return flags === 0;
    default:
      return true;
  }
}

// One shared collator: passing options to localeCompare on every call is slow when
// sorting tens of thousands of rows.
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export function compareText(a: string, b: string): number {
  return collator.compare(a, b);
}

/** Split a search box value into lower-case words; a row must contain every one of them. */
export function searchTerms(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean);
}
