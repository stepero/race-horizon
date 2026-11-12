export const COUNTRIES: { code: string; name: string }[] = [
  { code: 'SK', name: 'Slovensko' }, { code: 'CZ', name: 'Česko' }, { code: 'HU', name: 'Maďarsko' }, { code: 'PL', name: 'Poľsko' },
  { code: 'AT', name: 'Rakúsko' }, { code: 'DE', name: 'Nemecko' }, { code: 'GB', name: 'Spojené kráľovstvo' }, { code: 'IE', name: 'Írsko' },
  { code: 'FR', name: 'Francúzsko' }, { code: 'IT', name: 'Taliansko' }, { code: 'ES', name: 'Španielsko' }, { code: 'PT', name: 'Portugalsko' },
  { code: 'NL', name: 'Holandsko' }, { code: 'BE', name: 'Belgicko' }, { code: 'CH', name: 'Švajčiarsko' }, { code: 'SE', name: 'Švédsko' },
  { code: 'NO', name: 'Nórsko' }, { code: 'FI', name: 'Fínsko' }, { code: 'DK', name: 'Dánsko' }, { code: 'GR', name: 'Grécko' },
  { code: 'HR', name: 'Chorvátsko' }, { code: 'SI', name: 'Slovinsko' }, { code: 'UA', name: 'Ukrajina' }, { code: 'US', name: 'USA' },
  { code: 'CA', name: 'Kanada' }, { code: 'MX', name: 'Mexiko' }, { code: 'BR', name: 'Brazília' }, { code: 'AR', name: 'Argentína' },
  { code: 'AU', name: 'Austrália' }, { code: 'NZ', name: 'Nový Zéland' }, { code: 'JP', name: 'Japonsko' }, { code: 'CN', name: 'Čína' },
  { code: 'KR', name: 'Južná Kórea' }, { code: 'IN', name: 'India' }, { code: 'AE', name: 'Spojené arabské emiráty' }, { code: 'ZA', name: 'Južná Afrika' },
];

export const countryName = (code: string): string => COUNTRIES.find((c) => c.code === code)?.name ?? code;

/** Avatary: farba pozadia a symbol (jednoduché znaky, nie obrázky). */
export const AVATARS: { bg: string; glyph: string }[] = [
  { bg: '#e10600', glyph: '★' }, { bg: '#ff8000', glyph: '⚡' }, { bg: '#ffd23e', glyph: '♞' }, { bg: '#2fbf71', glyph: '✦' },
  { bg: '#1e90ff', glyph: '◆' }, { bg: '#7a4dff', glyph: '☄' }, { bg: '#e8559a', glyph: '✪' }, { bg: '#4b5563', glyph: '♛' },
];
