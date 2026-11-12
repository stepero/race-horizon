type Kid = Node | string | number | null | undefined | false;
type Props = Record<string, unknown> | null;

/** Malý pomocník na skladanie DOM bez knižnice. `class`, `style`, `on*` a ostatné atribúty. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = null, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = String(v);
      else if (k === 'style') e.setAttribute('style', String(v));
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') (e as unknown as Record<string, unknown>)[k] = v;
      else e.setAttribute(k, String(v));
    }
  }
  for (const kid of kids) {
    if (kid == null || kid === false) continue;
    e.append(typeof kid === 'object' ? kid : String(kid));
  }
  return e;
}

/** Zapíše text len ak sa zmenil (šetrí DOM v každej snímke). */
export function setText(e: HTMLElement, s: string): void {
  if (e.textContent !== s) e.textContent = s;
}

export function setClass(e: HTMLElement, cls: string, on: boolean): void {
  if (e.classList.contains(cls) !== on) e.classList.toggle(cls, on);
}

/** Skupina tlačidiel pre výber jednej hodnoty. */
export function segmented<T extends string | number>(
  options: { value: T; label: string }[], value: T, onChange: (v: T) => void,
): HTMLElement {
  const wrap = el('div', { class: 'seg' });
  const btns: HTMLButtonElement[] = [];
  for (const o of options) {
    const b = el('button', { type: 'button', class: 'seg-btn' + (o.value === value ? ' on' : ''), onclick: () => {
      btns.forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      onChange(o.value);
    } }, o.label);
    btns.push(b);
    wrap.append(b);
  }
  return wrap;
}

export function field(label: string, control: Node, hint?: string): HTMLElement {
  return el('div', { class: 'field' }, el('label', null, label), el('div', { class: 'ctl' }, control, hint ? el('small', null, hint) : null));
}

export function slider(min: number, max: number, step: number, value: number, onInput: (v: number) => void, fmt: (v: number) => string = String): HTMLElement {
  const out = el('output', null, fmt(value));
  const inp = el('input', { type: 'range', min, max, step, value: String(value), oninput: () => { const v = Number(inp.value); out.textContent = fmt(v); onInput(v); } });
  inp.value = String(value);
  return el('div', { class: 'slider' }, inp, out);
}
